// AI token accounting -- backs the "AI 用量" columns of the admin user list
// (users.ai_tokens_used) and the 数据看板 (plans.ai_tokens_used), see
// 20261027000000-user-ai-tokens-used.js / 20261027010000-plan-ai-tokens-used.js.
//
// Attribution rides on AsyncLocalStorage rather than a userId threaded
// through every LLM call site: authJwt.js runs the rest of each
// authenticated request inside runAsUser, and the context follows every
// promise/await that request starts -- including work it fires and forgets
// (a 欣欣小助手 turn that keeps running after the response, a batch AI 点评
// an admin kicks off, ingestion after an upload), which is billed to whoever
// started it. Calls outside any request (server-start jobs, CLI scripts)
// have no user and aren't counted.
//
// A call is also counted toward a plan when it runs inside runForPlan: AI
// 打分/点评 of that plan (aiPlanEvaluation.js#evaluatePlan) and 欣欣小助手
// turns about it (chat.controller.js's task runner). Everything else --
// general chat, drafting a not-yet-existing plan, library work -- counts
// toward the user only.
const { AsyncLocalStorage } = require("async_hooks");
const db = require("../models");

const storage = new AsyncLocalStorage();

const runAsUser = (userId, fn) => storage.run({ ...storage.getStore(), userId }, fn);
const runForPlan = (planId, fn) => (planId ? storage.run({ ...storage.getStore(), planId }, fn) : fn());

// DashScope's compatible-mode responses report prompt_tokens /
// completion_tokens, the native API (webSearch) input_tokens /
// output_tokens; both carry total_tokens, the rest is a fallback.
const tokensOf = (usage) => {
  if (!usage) return 0;
  const n =
    usage.total_tokens ??
    (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Fire-and-forget like authJwt.js's lastActivityAt write: an accounting miss
// must never fail the AI call it's counting. An atomic increment, so
// concurrent calls (agent tool rounds, a batch) don't race. silent: usage
// isn't an edit, so updatedAt stays put.
const increment = (model, id, tokens) =>
  model.increment({ aiTokensUsed: tokens }, { where: { id }, silent: true }).catch((e) => {
    console.error(`Failed to record AI token usage for ${model.name}`, id, e.message);
  });

const recordUsage = (usage) => {
  const { userId, planId } = storage.getStore() || {};
  const tokens = tokensOf(usage);
  if (!tokens) return;
  if (userId) increment(db.user, userId, tokens);
  if (planId) increment(db.plan, planId, tokens);
};

module.exports = { runAsUser, runForPlan, recordUsage };
