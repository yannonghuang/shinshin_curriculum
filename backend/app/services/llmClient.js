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
// thinking: false turns off a reasoning model's hidden "thinking" pass
// (DashScope's enable_thinking) -- for small mechanical calls (picking
// library sections, summarizing history) where it only adds latency: a
// profiled chat turn spent ~30s per knowledge-base search producing ~1,500
// reasoning tokens for ~200 characters of JSON. Omitted = model default.
async function llmChat({ systemPrompt, messages, maxTokens = 1024, temperature = 0.2, model, provider, tools, toolChoice, thinking }) {
  const effectiveProvider = (provider || process.env.LLM_PROVIDER || "dashscope").toLowerCase();
  const resolvedModel = model || process.env.AI_REVIEW_MODEL || DEFAULT_MODELS[effectiveProvider];
  if (effectiveProvider !== "dashscope") {
    throw new Error(`Unsupported LLM_PROVIDER: ${effectiveProvider}`); // extend here if another provider is added later
  }
  return dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model: resolvedModel, tools, toolChoice, thinking });
}

// Transient failures are retried: the app runs in Hong Kong against a
// mainland endpoint, and connections occasionally stall until Node's 10s
// connect timeout ("fetch failed", nothing reached the model, nothing
// billed); DashScope also rate-limits (429) and has the odd 5xx. Without a
// retry one such hiccup failed a whole plan in a batch. Delays back off
// (honouring Retry-After when given); a client error (4xx other than 429)
// is never retried -- it would just fail the same way again.
const RETRY_DELAYS_MS = [3000, 10000, 30000];
const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "fetch failed" alone hides why -- the undici cause code (e.g.
// UND_ERR_CONNECT_TIMEOUT, ECONNRESET) is what tells a stalled connection
// from anything else.
const networkErrorMessage = (e) => {
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  return cause ? `${e.message} (${cause})` : e.message;
};

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= RETRY_DELAYS_MS.length;
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      const message = networkErrorMessage(e);
      if (last) throw new Error(`DashScope 网络错误，重试 ${attempt} 次后仍失败：${message}`);
      console.warn(`DashScope 请求失败（${message}），${RETRY_DELAYS_MS[attempt] / 1000} 秒后重试（第 ${attempt + 1} 次）`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (resp.ok) return resp;
    const text = await resp.text();
    if (last || !RETRYABLE_STATUS(resp.status)) {
      throw new Error(`DashScope API error ${resp.status}${attempt ? `（重试 ${attempt} 次后）` : ""}: ${text}`);
    }
    const retryAfter = Number(resp.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : RETRY_DELAYS_MS[attempt];
    console.warn(`DashScope 返回 ${resp.status}，${delay / 1000} 秒后重试（第 ${attempt + 1} 次）`);
    await sleep(delay);
  }
}

async function dashscopeChat({ systemPrompt, messages, maxTokens, temperature, model, tools, toolChoice, thinking }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const all = [];
  if (systemPrompt) all.push({ role: "system", content: systemPrompt });
  all.push(...messages);
  const body = { model, max_tokens: maxTokens, temperature, messages: all };
  if (thinking === false) body.enable_thinking = false;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
// Web search through DashScope's built-in search plugin -- used by
// 欣欣小助手's web_search tool (copilotActions.js) as its own one-shot call,
// because search doesn't happen on a request that also carries tools (the
// chat turn always does). Native API, not compatible-mode: only the native
// response carries the search_info source list (titles + URLs), which is
// what lets replies cite real pages instead of links the model makes up.
// Newer Qwen models are served on the multimodal-generation path and older
// ones on text-generation (the wrong one answers 400 "url error"), so this
// tries the first and falls back to the second.
const SEARCH_PATHS = [
  { path: "/api/v1/services/aigc/multimodal-generation/generation", content: (text) => [{ text }] },
  { path: "/api/v1/services/aigc/text-generation/generation", content: (text) => text },
];

async function webSearch({ prompt, model, maxTokens = 1500 }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const host = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(
    /\/compatible-mode\/v1\/?$/,
    ""
  );
  const resolvedModel = model || process.env.COPILOT_SEARCH_MODEL || process.env.AI_REVIEW_MODEL || DEFAULT_MODELS.dashscope;
  let lastError;
  for (const { path, content } of SEARCH_PATHS) {
    try {
      const resp = await fetchWithRetry(`${host}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: resolvedModel,
          input: { messages: [{ role: "user", content: content(prompt) }] },
          parameters: {
            result_format: "message",
            max_tokens: maxTokens,
            temperature: 0.2,
            // A summary of search results needs no long hidden reasoning --
            // that's most of the latency otherwise (ignored by models
            // without a thinking mode).
            enable_thinking: false,
            enable_search: true,
            search_options: {
              forced_search: true,
              enable_source: true,
              enable_citation: true,
              citation_format: "[ref_<number>]",
              search_strategy: "turbo",
            },
          },
        }),
      });
      const data = await resp.json();
      const message = data.output?.choices?.[0]?.message;
      const raw = message?.content;
      const text = Array.isArray(raw) ? raw.map((part) => part.text || "").join("") : raw || "";
      const results = data.output?.search_info?.search_results || [];
      return {
        text,
        sources: results.map((r) => ({ index: r.index, title: r.title, url: r.url, site: r.site_name })),
        model: resolvedModel,
      };
    } catch (e) {
      lastError = e;
      if (!/url error/i.test(e.message)) throw e;
    }
  }
  throw lastError;
}

module.exports = { llmChat, fetchWithRetry, webSearch };
