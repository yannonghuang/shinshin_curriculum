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
async function runAgentLoop({ systemPrompt, messages, tools, executors, maxRounds = 3, ...llmOpts }) {
  const conversation = [...messages];
  const toolCallLog = [];

  for (let round = 0; round < maxRounds; round += 1) {
    // The last round is offered no tools at all -- the model literally
    // cannot ask for one, so it's forced to give a final answer, guaranteeing
    // the loop terminates within maxRounds calls rather than needing a
    // separate "give up" branch.
    const isLastRound = round === maxRounds - 1;
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

    for (const call of result.toolCalls) {
      const name = call.function?.name;
      const executor = executors[name];
      let output;
      if (!executor) {
        output = { error: `Unknown tool: ${name}` };
      } else {
        let args;
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (e) {
          // Long free-text arguments (e.g. a whole drafted plan) are where a
          // model most often slips -- typically an unescaped " inside a
          // string. Saying so explicitly makes the retry land first time.
          output = { error: `工具参数不是合法的 JSON（${e.message}）。请检查字符串中的双引号是否已转义（\\"）或改用中文引号「」，然后重新调用。` };
        }
        if (!output) {
          try {
            output = await executor(args);
          } catch (e) {
            output = { error: e.message || "Tool execution failed" };
          }
        }
      }
      toolCallLog.push({ name, arguments: call.function?.arguments, output });
      conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  // Unreachable in practice (the forced-no-tools last round above always
  // returns first) -- kept only as a safety net for maxRounds <= 0.
  const fallback = await llmClient.llmChat({ systemPrompt, messages: conversation, ...llmOpts });
  return { text: fallback.text, model: fallback.model, toolCallLog };
}

module.exports = { runAgentLoop };
