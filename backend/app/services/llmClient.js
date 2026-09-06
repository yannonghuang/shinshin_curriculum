// Provider-agnostic LLM client. LLM_PROVIDER env-selected, default "dashscope"
// (Alibaba Cloud DashScope, OpenAI-compatible wire format). Qwen3.8-Max via
// DashScope is the active/default provider for this app — do NOT add an
// Anthropic branch here, per the approved plan.

const DEFAULT_MODELS = { dashscope: "qwen3.8-max" };

// tools/toolChoice (OpenAI-style function-calling shape -- DashScope's
// compatible-mode endpoint speaks the same wire format) are optional and
// passed straight through when given; see agentLoop.js for the loop that
// actually drives a multi-round tool-calling conversation. A plain
// (no-tools) caller like review.controller.js's original single-shot usage
// is completely unaffected -- toolCalls just comes back undefined.
async function llmChat({ systemPrompt, messages, maxTokens = 1024, temperature = 0.2, model, provider, tools, toolChoice }) {
  const effectiveProvider = (provider || process.env.LLM_PROVIDER || "dashscope").toLowerCase();
  const resolvedModel = model || process.env.AI_REVIEW_MODEL || DEFAULT_MODELS[effectiveProvider];
  if (effectiveProvider !== "dashscope") {
    throw new Error(`Unsupported LLM_PROVIDER: ${effectiveProvider}`); // extend here if another provider is added later
  }
  return dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model: resolvedModel, tools, toolChoice });
}

async function dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model, tools, toolChoice }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const all = [];
  if (systemPrompt) all.push({ role: "system", content: systemPrompt });
  all.push(...messages);
  const body = { model, max_tokens: maxTokens, temperature, messages: all };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`DashScope API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;
  // A tool-calling turn legitimately has no `content` -- only treat "no
  // content AND no tool_calls" as the response-contained-nothing error this
  // already threw on before tools existed.
  if (!message || (!message.content && (!toolCalls || toolCalls.length === 0))) {
    throw new Error("DashScope response contained no content");
  }
  return { text: message.content || null, toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined, model };
}
module.exports = { llmChat };
