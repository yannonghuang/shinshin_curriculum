const llmClient = require("./llmClient");

// 欣欣小助手's plan-drafting sub-agent, behind the draft_plan tool
// (copilotActions.js). Drafting a whole 乡土课程设计 in the main chat loop was
// its slowest job: research rounds one after another, then one model call
// writing ~3,000 characters in a single stream (a profiled request took
// 125s). Here the work is split so most of it runs side by side:
//
//   1. research   -- template, 学习资源库 and web search, in parallel
//   2. outline    -- one short call: theme + the lesson-by-lesson plan
//   3. write      -- the overall fields and every lesson, in parallel
//   4. assemble   -- template-shaped content (ready for create_plan) and a
//                    Markdown rendering for the chat
//
// The result goes straight back as the reply (see agentLoop.js's
// finalReply), so the main model never re-types the whole draft.
//
// The caller injects research functions and a progress hook, keeping this
// file free of the tool/route plumbing:
//   deps.loadTemplate()       -> get_plan_template's result
//   deps.searchLibrary(query) -> { context, sources }
//   deps.webSearch(query)     -> { summary, webSources } | null
//   deps.emit({ key, label, status })

// All parts at once for a typical course (2 overall parts + up to 6
// lessons), so writing takes about as long as its slowest part; a longer
// course runs in a second wave rather than stacking up more calls at the
// model provider at once.
const WRITE_CONCURRENCY = 8;
const RESEARCH_CHARS = 5000;

const SYSTEM_PROMPT =
  "你是乡土课程设计专家，为中国乡村/县域小学教师撰写项目式（PBL）乡土课程设计。内容要具体、可操作、贴合当地实际与学生年龄，" +
  "优先使用所给参考资料中的本地事实；参考资料中没有的具体事实（年代、人名、数据）不要编造。用中文。";

// The outermost {...} -- tolerates a ```json fence or a stray sentence
// around the object.
const parseJson = (text) => {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("模型未返回 JSON");
  return JSON.parse(raw.slice(start, end + 1));
};

// One JSON-returning call, retried once on unparseable output -- with
// thinking off, a malformed reply is rare and a retry is cheap.
async function askJson(userContent, maxTokens) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await llmClient.llmChat({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens,
      temperature: 0.5,
      thinking: false,
    });
    try {
      return parseJson(result.text);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`起草内容解析失败：${lastError.message}`);
}

// Runs fn over items with at most `limit` in flight, results in input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const fieldLines = (fields) =>
  fields.map((f) => `- ${f.key}：${f.group ? `【${f.group}】` : ""}${f.label}${f.hint ? `（填写提示：${f.hint.replace(/\s+/g, " ")}）` : ""}`).join("\n");

const asText = (v) => (Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v)).trim();

// Markdown for the chat bubble, grouped the way the template's own form is.
function renderMarkdown({ basic, planFields, lessonFields, fields, lessons, lessonBreakdownLabel }) {
  const out = [`# ${basic.title}`, ""];
  out.push("| 项目 | 内容 |", "|---|---|");
  out.push(`| 乡土主题 | ${basic.theme || "—"} |`, `| 年级 | ${basic.grade || "—"} |`, `| 课时 | ${basic.plannedLessonCount} 课时 |`, "");
  let section = null;
  let group = null;
  for (const f of planFields) {
    const value = asText(fields[f.key]);
    if (!value) continue;
    if (f.section !== section) {
      section = f.section;
      group = null;
      out.push(`## ${section}`, "");
    }
    if (f.group && f.group !== group) {
      group = f.group;
      out.push(`### ${group}`, "");
    }
    out.push(`**${f.label.replace(/[：:]\s*$/, "")}**`, "", value, "");
  }
  out.push(`## ${lessonBreakdownLabel || "分课时设计"}`, "");
  for (const l of lessons) {
    const titleField = lessonFields[0];
    out.push(`### 第 ${l.index} 课时${titleField && l.fields[titleField.key] ? `：${asText(l.fields[titleField.key])}` : ""}`, "");
    for (const f of lessonFields.slice(1)) {
      const value = asText(l.fields[f.key]);
      if (value) out.push(`**${f.label.replace(/^\d+\.\s*/, "").replace(/[：:]\s*$/, "")}**`, "", value, "");
    }
  }
  return out.join("\n");
}

async function draftPlan(args, deps) {
  const emit = deps.emit || (() => {});
  const title = String(args.title || "").trim();
  if (!title) throw new Error("请提供课程标题或主题。");
  const lessonCount = Math.min(Math.max(Math.round(Number(args.lessonCount) || 5), 2), 12);
  const grade = String(args.grade || "").trim();
  const requirements = String(args.requirements || "").trim();

  // 1. research -----------------------------------------------------------
  emit({ key: "research", label: "收集资料（模板 / 学习资源库 / 网络）", status: "running" });
  const [template, library, web] = await Promise.all([
    deps.loadTemplate(),
    deps.searchLibrary(`「${title}」乡土课程设计（${grade || "小学"}）：主题背景、驱动问题与课程设计框架参考`).catch(() => null),
    deps.webSearch ? deps.webSearch(`${title} 历史 文化 特色 制作 习俗`).catch(() => null) : null,
  ]);
  emit({ key: "research", status: "done" });

  const planFields = template.planFields || [];
  const lessonFields = template.lessonFields || [];
  const research = [
    web && web.summary ? `【网络检索（未经审核）】\n${web.summary}` : "",
    library && library.context ? `【学习资源库参考】\n${library.context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, RESEARCH_CHARS);
  const brief =
    `课程标题：${title}\n年级：${grade || "未指定（按小学中高年级）"}\n课时数：${lessonCount}` +
    `${args.theme ? `\n乡土主题：${args.theme}` : ""}${requirements ? `\n教师的具体要求：${requirements}` : ""}`;

  // 2. outline ------------------------------------------------------------
  emit({ key: "outline", label: "拟定课程大纲", status: "running" });
  const outline = await askJson(
    `${brief}\n\n可选乡土主题：${(template.themeOptions || []).join("、")}\n\n参考资料：\n${research || "（无）"}\n\n` +
      `请为这门课拟定大纲，按 PBL 流程（入项 → 探究 → 制作与迭代 → 出项）把 ${lessonCount} 个课时依次分配好。严格只输出 JSON：` +
      `{"theme":"从可选乡土主题中选一个最贴切的，没有合适的留空","drivingQuestion":"儿童视角的驱动问题","finalProducts":"个人成果与团队成果，一句话",` +
      `"lessons":[{"index":1,"stage":"入项","title":"课时标题","focus":"本课时要做什么，一两句话"}]}`,
    1500
  );
  const outlineLessons = (Array.isArray(outline.lessons) ? outline.lessons : []).slice(0, lessonCount);
  while (outlineLessons.length < lessonCount) {
    outlineLessons.push({ index: outlineLessons.length + 1, stage: "", title: `第 ${outlineLessons.length + 1} 课时`, focus: "" });
  }
  outlineLessons.forEach((l, i) => {
    l.index = i + 1;
  });
  emit({ key: "outline", status: "done" });

  const outlineText =
    `驱动问题：${outline.drivingQuestion || ""}\n最终成果：${outline.finalProducts || ""}\n课时安排：\n` +
    outlineLessons.map((l) => `第${l.index}课时【${l.stage || ""}】${l.title}：${l.focus || ""}`).join("\n");
  const shared = `${brief}\n\n课程大纲：\n${outlineText}\n\n参考资料：\n${research || "（无）"}`;

  // 3. write, in parallel --------------------------------------------------
  // Overall fields split in two (goals + intro / the HOW stages) so neither
  // call is the long pole; each lesson is its own call.
  const whyWhat = planFields.filter((f) => !/^s2\./.test(f.key) && !/HOW/i.test(f.section || ""));
  const how = planFields.filter((f) => !whyWhat.includes(f));
  const jobs = [
    { kind: "fields", label: "目标与项目简介", fields: whyWhat },
    { kind: "fields", label: "课程设计（入项 / 探究 / 制作与迭代 / 出项）", fields: how },
    ...outlineLessons.map((l) => ({ kind: "lesson", label: `第 ${l.index} 课时：${l.title}`, lesson: l })),
  ].filter((j) => j.kind === "lesson" || j.fields.length > 0);

  let doneCount = 0;
  const progressLabel = () => `并行撰写各部分（${doneCount}/${jobs.length}）`;
  emit({ key: "write", label: progressLabel(), status: "running" });
  const results = await mapLimit(jobs, WRITE_CONCURRENCY, async (job) => {
    let result;
    if (job.kind === "fields") {
      result = await askJson(
        `${shared}\n\n请按大纲撰写以下课程设计字段的内容（每个字段 60-200 字，条理清楚，可分点；各字段内容互相衔接、与大纲一致）。` +
          `严格只输出 JSON，键为字段 key，值为字段内容（字符串）：\n${fieldLines(job.fields)}`,
        2500
      );
    } else {
      const l = job.lesson;
      result = await askJson(
        `${shared}\n\n请详细撰写第 ${l.index} 课时（${l.stage ? `${l.stage}阶段，` : ""}「${l.title}」：${l.focus || ""}）的分课时设计。` +
          `教学活动流程要分步骤并标注大致时长（共约 40 分钟）。严格只输出 JSON，键为字段 key，值为字段内容（字符串）：\n` +
          `${fieldLines(lessonFields)}\n其中 ${lessonFields[0] ? lessonFields[0].key : "f0"} 填「${l.title}（${l.stage || "PBL步骤"}）」。`,
        1800
      );
    }
    doneCount += 1;
    emit({ key: "write", label: progressLabel(), status: doneCount === jobs.length ? "done" : "running" });
    return result;
  });

  // 4. assemble -------------------------------------------------------------
  const fields = {};
  const lessons = [];
  jobs.forEach((job, i) => {
    const r = results[i] || {};
    if (job.kind === "fields") {
      for (const f of job.fields) if (asText(r[f.key])) fields[f.key] = asText(r[f.key]);
    } else {
      const lf = {};
      for (const f of lessonFields) if (asText(r[f.key])) lf[f.key] = asText(r[f.key]);
      lessons.push({ index: job.lesson.index, fields: lf });
    }
  });
  const theme = (template.themeOptions || []).includes(outline.theme) ? outline.theme : args.theme && (template.themeOptions || []).includes(args.theme) ? args.theme : undefined;
  const gradeOption = (template.grades || []).find((g) => g === grade || (grade && g.includes(grade.replace(/年级$/, "")))) || undefined;
  const basic = { title, theme, grade: gradeOption || grade || undefined, plannedLessonCount: lessonCount };

  return {
    basic,
    fields,
    lessons,
    markdown: renderMarkdown({ basic, planFields, lessonFields, fields, lessons, lessonBreakdownLabel: template.lessonBreakdownLabel }),
    librarySources: (library && library.sources) || [],
    webSources: (web && web.webSources) || [],
  };
}

module.exports = { draftPlan };
