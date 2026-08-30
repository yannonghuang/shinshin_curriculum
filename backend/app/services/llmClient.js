// Provider-agnostic LLM client. LLM_PROVIDER env-selected, default "dashscope"
// (Alibaba Cloud DashScope, OpenAI-compatible wire format). Qwen3.8-Max via
// DashScope is the active/default provider for this app — do NOT add an
// Anthropic branch here, per the approved plan.

const DEFAULT_MODELS = { dashscope: "qwen3.8-max" };

async function llmChat({ systemPrompt, messages, maxTokens = 1024, temperature = 0.2, model, provider }) {
  const effectiveProvider = (provider || process.env.LLM_PROVIDER || "dashscope").toLowerCase();
  const resolvedModel = model || process.env.AI_REVIEW_MODEL || DEFAULT_MODELS[effectiveProvider];
  if (effectiveProvider !== "dashscope") {
    throw new Error(`Unsupported LLM_PROVIDER: ${effectiveProvider}`); // extend here if another provider is added later
  }
  return dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model: resolvedModel });
}

async function dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const all = [];
  if (systemPrompt) all.push({ role: "system", content: systemPrompt });
  all.push(...messages);
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: all }),
  });
  if (!resp.ok) throw new Error(`DashScope API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("DashScope response contained no content");
  return { text: content, model };
}
module.exports = { llmChat };
