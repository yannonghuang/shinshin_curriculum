const llmClient = require("./llmClient");

// Generic tool-calling agent loop -- shared by the co-pilot chat endpoint
// (chat.controller.js) and AI-review's augmented prompt (review.controller.js).
// This is the entire "agent" abstraction this app needs: call the model, and
// if it asks to call a tool, run it and hand the result back, repeating
// until it gives a final answer or maxRounds is hit. Not a framework, not a
// spawned sub-process -- one function, one conversation array.
//
// `tools` is the OpenAI-style tool-definition array passed straight through
// to llmClient.llmChat (DashScope's compatible-mode endpoint speaks the same
// wire format). `executors` maps each tool's `name` to an async
// function(args) -> JSON-serializable result. `messages` is the running
// conversation (system prompt passed separately, same convention as
// llmClient.llmChat).
// Optional hooks (used by chat.controller.js's background turns):
//   isReadOnly(name, args) -- which calls may run concurrently (see below)
//   onEvent({ type, ... })  -- "round_start" / "tool_start" / "tool_end",
//                              for a live progress display
//   shouldStop()           -- checked between rounds; true ends the loop
//                              early with { stopped: true } (a cancel)
async function runAgentLoop({ systemPrompt, messages, tools, executors, maxRounds = 3, isReadOnly, onEvent, shouldStop, ...llmOpts }) {
  const conversation = [...messages];
  const toolCallLog = [];

  for (let round = 0; round < maxRounds; round += 1) {
    // The last round is offered no tools at all -- the model literally
    // cannot ask for one, so it's forced to give a final answer, guaranteeing
    // the loop terminates within maxRounds calls rather than needing a
    // separate "give up" branch.
    const isLastRound = round === maxRounds - 1;
    if (shouldStop && shouldStop()) return { text: null, model: null, toolCallLog, stopped: true };
    if (onEvent) onEvent({ type: "round_start", round, final: isLastRound });
    const result = await llmClient.llmChat({
      systemPrompt,
      messages: conversation,
      tools: isLastRound ? undefined : tools,
      ...llmOpts,
    });

    if (!result.toolCalls) {
      return { text: result.text, model: result.model, toolCallLog };
    }

    // The assistant's own tool-call request must be echoed back verbatim
    // before the tool-result messages, per the OpenAI/DashScope tool-calling
    // message convention -- the model needs to see its own request in the
    // history to make sense of what follows.
    conversation.push({ role: "assistant", content: result.text || null, tool_calls: result.toolCalls });

    // Read-only calls in a round (e.g. two knowledge-base searches, or a
    // search plus a web search) run concurrently -- they were sequential,
    // which doubled a profiled turn's wait for no reason. Anything that
    // writes runs alone, in the model's order, after them -- results are
    // still logged and handed back in the order the model asked.
    const parsed = result.toolCalls.map((call) => {
      const name = call.function?.name;
      try {
        return { call, name, args: call.function?.arguments ? JSON.parse(call.function.arguments) : {} };
      } catch (e) {
        // Long free-text arguments (e.g. a whole drafted plan) are where a
        // model most often slips -- typically an unescaped " inside a
        // string. Saying so explicitly makes the retry land first time.
        return {
          call,
          name,
          done: true,
          output: { error: `工具参数不是合法的 JSON（${e.message}）。请检查字符串中的双引号是否已转义（\\"）或改用中文引号「」，然后重新调用。` },
        };
      }
    });
    const execute = async (p) => {
      if (p.done) return;
      p.done = true; // before any await -- the sequential pass must not re-run it
      const executor = executors[p.name];
      if (!executor) {
        p.output = { error: `Unknown tool: ${p.name}` };
        return;
      }
      if (onEvent) onEvent({ type: "tool_start", name: p.name, args: p.args });
      try {
        p.output = await executor(p.args, {
          emit: (sub) => onEvent && onEvent({ type: "substep", tool: p.name, ...sub }),
        });
      } catch (e) {
        p.output = { error: e.message || "Tool execution failed" };
      }
      if (onEvent) onEvent({ type: "tool_end", name: p.name });
    };
    const parallel = parsed.filter((p) => !p.done && isReadOnly && isReadOnly(p.name, p.args));
    await Promise.all(parallel.map(execute));
    for (const p of parsed) await execute(p); // writes, sequentially (done ones are skipped)

    for (const p of parsed) {
      toolCallLog.push({ name: p.name, arguments: p.call.function?.arguments, output: p.output });
      conversation.push({ role: "tool", tool_call_id: p.call.id, content: JSON.stringify(p.output) });
    }
    // A tool that produced the finished reply itself (draft_plan's whole
    // drafted plan) ends the turn here: another model round would only
    // re-type thousands of characters it already has. Its finalReply is
    // kept out of the stored log -- it *is* the message content.
    const finished = parsed.find((p) => p.output && typeof p.output.finalReply === "string");
    if (finished) {
      const text = finished.output.finalReply;
      const entry = toolCallLog.find((e) => e.output === finished.output);
      if (entry) entry.output = { ...finished.output, finalReply: undefined };
      return { text, model: result.model, toolCallLog };
    }
    if (shouldStop && shouldStop()) return { text: null, model: result.model, toolCallLog, stopped: true };
  }

  // Unreachable in practice (the forced-no-tools last round above always
  // returns first) -- kept only as a safety net for maxRounds <= 0.
  const fallback = await llmClient.llmChat({ systemPrompt, messages: conversation, ...llmOpts });
  return { text: fallback.text, model: fallback.model, toolCallLog };
}

module.exports = { runAgentLoop };
