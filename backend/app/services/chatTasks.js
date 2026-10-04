const db = require("../models");
const ChatTask = db.chatTask;
const ChatMessage = db.chatMessage;
const { Op } = db.Sequelize;

// Background turns for 欣欣小助手. Every message the teacher sends is answered
// by a task: the send request waits a few seconds for it (most answers are
// done by then and come back inline, exactly as before), and otherwise
// returns the task so the panel can show a progress card while the teacher
// keeps chatting. A profiled plan-drafting request held the panel blocked
// for over two minutes before this.
//
// In-process, not a separate queue/worker service: the work is almost all
// waiting on the model API, so a single Node process runs a few turns at
// once comfortably, and the app has no other queue infrastructure. The row
// in chat_tasks is the durable record (status/steps/reply); the in-memory
// registry only holds what a live run needs (cancel flag, waiters). A
// restart loses live runs -- see markInterruptedOnStartup.

// The 1-vCPU production box runs everything else too; LLM-bound turns are
// cheap on CPU, but each holds a history + tool context in memory.
const MAX_RUNNING = 3;
const MAX_RUNNING_PER_USER = 2;
// A turn that's still going after this is abandoned (the in-flight model
// call can't be aborted, but its result is discarded).
const TASK_TIMEOUT_MS = 5 * 60 * 1000;

// Lazy: copilotActions.js pulls in the route registry, which needs the app's
// routes loaded first.
const labelOf = (name) => require("./copilotActions").labelOf(name);

let runner = null; // (task, { onEvent, shouldStop }) -> assistant message row, or null if stopped
const live = new Map(); // taskId -> { cancelled, timedOut, steps, waiters: Set<fn> }
const queue = []; // taskIds waiting for a slot, FIFO
const runningByUser = new Map();
let runningCount = 0;

// chat.controller.js supplies the actual "answer this turn" function -- this
// module only schedules and records.
const setRunner = (fn) => {
  runner = fn;
};

const now = () => new Date().toISOString();

// Progress steps from agentLoop.js's events: an opening "分析问题" step,
// one step per tool call (concurrent ones run side by side), and a
// "撰写回复" step for each later model round. labelOf maps a tool name to
// its 中文 label (copilotActions.js).
const applyEvent = (steps, event, labelOf) => {
  const closeThinking = () => {
    for (const s of steps) if (s.status === "running" && !s.tool && !s.sub) Object.assign(s, { status: "done", endedAt: now() });
  };
  if (event.type === "round_start") {
    closeThinking();
    steps.push({ label: event.round === 0 ? "分析问题" : "整理并撰写回复", status: "running", startedAt: now() });
  } else if (event.type === "tool_start") {
    closeThinking();
    steps.push({ label: labelOf(event.name) || event.name, tool: event.name, status: "running", startedAt: now() });
  } else if (event.type === "tool_end") {
    const step = steps.find((s) => s.tool === event.name && s.status === "running");
    if (step) Object.assign(step, { status: "done", endedAt: now() });
    for (const s of steps) if (s.sub && s.parent === event.name && s.status === "running") Object.assign(s, { status: "done", endedAt: now() });
  } else if (event.type === "substep") {
    // A long tool's own progress (draft_plan: research / outline / writing
    // n of m), shown indented under it; the same key updates in place.
    const subKey = `${event.tool}:${event.key}`;
    let step = steps.find((s) => s.subKey === subKey);
    if (!step) {
      step = { subKey, sub: true, parent: event.tool, label: event.label || event.key, status: "running", startedAt: now() };
      steps.push(step);
    }
    if (event.label) step.label = event.label;
    if (event.status === "done") Object.assign(step, { status: "done", endedAt: now() });
  }
};

const finishSteps = (steps) => steps.map((s) => (s.status === "running" ? { ...s, status: "done", endedAt: now() } : s));

const notify = (taskId) => {
  const entry = live.get(Number(taskId));
  if (!entry) return;
  for (const fn of entry.waiters) fn();
  entry.waiters.clear();
};

const pump = () => {
  for (let i = 0; i < queue.length && runningCount < MAX_RUNNING; ) {
    const taskId = queue[i];
    const entry = live.get(taskId);
    if (!entry) {
      queue.splice(i, 1);
      continue;
    }
    if ((runningByUser.get(entry.userId) || 0) >= MAX_RUNNING_PER_USER) {
      i += 1;
      continue;
    }
    queue.splice(i, 1);
    run(taskId);
  }
};

async function run(taskId) {
  const entry = live.get(taskId);
  runningCount += 1;
  runningByUser.set(entry.userId, (runningByUser.get(entry.userId) || 0) + 1);
  const task = await ChatTask.findByPk(taskId);
  const timer = setTimeout(() => {
    entry.timedOut = true;
  }, TASK_TIMEOUT_MS);
  let persistTimer = null;
  const persistSteps = () => {
    // Coalesced: a round can fire several events within milliseconds.
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      ChatTask.update({ steps: entry.steps }, { where: { id: taskId } }).catch(() => {});
    }, 300);
  };
  try {
    await task.update({ status: "running", startedAt: new Date(), steps: [], error: null });
    entry.steps = [];
    const reply = await runner(task, {
      context: entry.context,
      shouldStop: () => entry.cancelled || entry.timedOut,
      onEvent: (event) => {
        applyEvent(entry.steps, event, labelOf);
        persistSteps();
      },
    });
    const steps = finishSteps(entry.steps);
    if (entry.timedOut && !entry.cancelled) {
      await task.update({ status: "failed", error: "处理超时，请重试或把问题拆小一些。", steps, finishedAt: new Date() });
    } else if (!reply) {
      // Cancelled -- a short reply keeps the conversation (and the model's
      // view of it) from carrying a question that was never answered.
      const note = await ChatMessage.create({
        conversationId: task.conversationId,
        role: "assistant",
        content: "（已取消该请求）",
        replyToMessageId: task.userMessageId,
      });
      await task.update({ status: "cancelled", assistantMessageId: note.id, steps, finishedAt: new Date() });
    } else {
      await task.update({ status: "done", assistantMessageId: reply.id, steps, finishedAt: new Date() });
    }
  } catch (e) {
    console.error(`欣欣小助手后台任务 #${taskId} 失败:`, e.message);
    await task
      .update({ status: "failed", error: e.message || "处理失败", steps: finishSteps(entry.steps || []), finishedAt: new Date() })
      .catch(() => {});
  } finally {
    clearTimeout(timer);
    if (persistTimer) clearTimeout(persistTimer);
    runningCount -= 1;
    runningByUser.set(entry.userId, (runningByUser.get(entry.userId) || 1) - 1);
    notify(taskId);
    live.delete(taskId);
    pump();
  }
}

const enqueue = (task, context) => {
  live.set(Number(task.id), {
    userId: Number(task.userId),
    context,
    cancelled: false,
    timedOut: false,
    steps: [],
    waiters: new Set(),
  });
  queue.push(Number(task.id));
  pump();
};

// Starts answering one recorded user message. `context` is whatever the
// runner needs beyond the row itself (e.g. the page the teacher sent from).
async function submit({ conversationId, userId, userMessageId, context }) {
  const task = await ChatTask.create({ conversationId, userId, userMessageId, status: "queued", steps: [] });
  enqueue(task, context);
  return task;
}

// Resolves true once the task has finished (any outcome), false if `ms`
// passes first.
const waitFor = (taskId, ms) =>
  new Promise((resolve) => {
    const entry = live.get(Number(taskId));
    if (!entry) return resolve(true);
    const timer = setTimeout(() => {
      entry.waiters.delete(done);
      resolve(false);
    }, ms);
    function done() {
      clearTimeout(timer);
      resolve(true);
    }
    entry.waiters.add(done);
  });

// What the panel shows for a task -- live steps while it runs, and the
// reply once there is one.
async function view(task) {
  const entry = live.get(Number(task.id));
  const out = {
    id: task.id,
    conversationId: task.conversationId,
    userMessageId: task.userMessageId,
    status: task.status,
    steps: entry && entry.steps ? entry.steps : task.steps || [],
    error: task.error,
    startedAt: task.startedAt,
    createdAt: task.createdAt,
    queuePosition: entry && task.status === "queued" ? queue.indexOf(Number(task.id)) + 1 : undefined,
  };
  if (task.assistantMessageId) out.assistantMessage = await ChatMessage.findByPk(task.assistantMessageId);
  return out;
}

const findOwned = (taskId, userId) => ChatTask.findOne({ where: { id: taskId, userId } });

// Still-unresolved tasks of one conversation -- running/queued ones, plus
// failed/interrupted ones still offering 重试 -- for the panel to restore
// its cards on (re)load. A day-old failure isn't worth resurfacing.
const unresolvedFor = (conversationId) =>
  ChatTask.findAll({
    where: {
      conversationId,
      status: { [Op.in]: ["queued", "running", "failed", "interrupted"] },
      createdAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    order: [["id", "ASC"]],
  });

async function cancel(task) {
  const entry = live.get(Number(task.id));
  if (entry) {
    entry.cancelled = true;
    const queuedAt = queue.indexOf(Number(task.id));
    if (queuedAt === -1) return; // running -- stops at its next checkpoint (see run)
    queue.splice(queuedAt, 1);
    live.delete(Number(task.id));
  }
  // Never started (queued), or a failed/interrupted card being dismissed.
  if (["queued", "failed", "interrupted"].includes(task.status)) {
    const note = await ChatMessage.create({
      conversationId: task.conversationId,
      role: "assistant",
      content: "（已取消该请求）",
      replyToMessageId: task.userMessageId,
    });
    await task.update({ status: "cancelled", assistantMessageId: note.id, finishedAt: new Date() });
  }
  notify(task.id);
}

async function retry(task, context) {
  if (!["failed", "interrupted"].includes(task.status)) {
    const err = new Error("该请求当前无需重试。");
    err.status = 409;
    throw err;
  }
  await task.update({ status: "queued", error: null, steps: [], finishedAt: null });
  enqueue(task, context);
}

// A restart (every deploy) kills whatever was running in this process --
// leave those rows saying so, with 重试 available, rather than "running"
// forever.
async function markInterruptedOnStartup() {
  const [count] = await ChatTask.update(
    { status: "interrupted", error: "服务器重启，处理被中断。", finishedAt: new Date() },
    { where: { status: { [Op.in]: ["queued", "running"] } } }
  );
  return count;
}

const isActive = (task) => ["queued", "running"].includes(task.status);

module.exports = { setRunner, submit, waitFor, view, findOwned, unresolvedFor, cancel, retry, markInterruptedOnStartup, isActive };
