const llmClient = require("./llmClient");

// 欣欣小助手's plan-drafting sub-agent, behind the draft_plan tool
// (copilotActions.js). Drafting a whole 乡土课程设计 in the main chat loop was
// its slowest job: research rounds one after another, then one model call
// writing ~3,000 characters in a single stream (a profiled request took
// 125s). Here the work is split so most of it runs side by side:
//
//   1. research   -- template, 学习资源库 and web search, in parallel
//   2. outline    -- one short call: theme, the overall goals, and the
//                    lesson-by-lesson plan with each goal assigned to the
//                    lesson(s) that deliver it (completed in code -- see
//                    planGoals), so goals and lessons agree by construction
//   3. write      -- the overall fields and every lesson, in parallel;
//                    any field a part left out is asked for again
//   4. assemble   -- template-shaped content (ready for create_plan) and a
//                    Markdown rendering for the chat
//
// No whole-draft "consistency pass" after writing: one was built and
// measured (3 topics, AI 打分 standard) -- ~30s more per draft, no score
// gain, and it corrupted a draft by writing a lesson's fixes over another
// lesson. The robustness fixes below (per-section parts, re-asking for
// missing fields, the school's locality) are what raised scores.
//
// The result goes straight back as the reply (see agentLoop.js's
// finalReply), so the main model never re-types the whole draft.
//
// The caller injects research functions and a progress hook, keeping this
// file free of the tool/route plumbing:
//   deps.loadTemplate()       -> get_plan_template's result
//   deps.searchLibrary(query) -> { context, sources }
//   deps.webSearch(query)     -> { summary, webSources } | null
//   deps.conversationDigest   -- the chat so far as text (optional; see
//                                distillConversation)
//   deps.standard             -- the AI 点评标准 in effect (optional; see
//                                standardBrief) -- what plans are judged by
//   deps.school               -- the teacher's school and region (optional):
//                                a course is judged on how local it is, so
//                                the drafter must know where "local" is
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

// The teacher's own context from the conversation -- school and students,
// stated requirements and preferences, things to avoid, points already
// agreed -- boiled down to a few bullets every writer gets. The model's
// draft_plan arguments carry only what it chose to pass; this is what keeps
// e.g. "不要做烹饪活动" from three turns back. Runs alongside research, so it
// adds no wait. "" when the conversation has nothing relevant.
async function distillConversation(digest, title) {
  if (!digest || !digest.trim()) return "";
  const result = await llmClient.llmChat({
    systemPrompt:
      "你负责从教师与AI助手的对话中提炼起草课程设计所需的背景与要求。只写对话中实际出现的内容，不要推测或补充。" +
      "助手提出的建议、附件里的内容，只有教师明确认可或要求时才算要求。",
    messages: [
      {
        role: "user",
        content:
          `教师现在要起草《${title}》乡土课程设计。以下是此前的对话：\n\n${digest}\n\n` +
          "请分条列出对起草有用的信息（学校与学生情况、教师明确提出的要求与偏好、需要避免的内容、已讨论确定的设计要点），" +
          "每条一句，最多 10 条，不要编号以外的其他文字。如果没有任何相关信息，只回答「无」。",
      },
    ],
    maxTokens: 600,
    temperature: 0.1,
    thinking: false,
  });
  const text = (result.text || "").trim();
  return /^[「"]?无[」"。.]?$/.test(text) ? "" : text;
}

// What the drafter is told about the AI 点评标准: the overview and, per
// dimension, its criteria and the top level's description -- the bar to
// write to. Score ranges are left out (no use to a writer). Read from the
// standard in effect each time, so an admin's revision of the standard
// reaches drafting with no code change. Before this, drafts met the
// standard's specifics (e.g. naming which 五根 a course cultivates) only when
// a library search happened to surface the source material -- 目标设计 lost
// the same points in every scored draft.
function standardBrief(standard) {
  const c = standard && standard.content;
  if (!c || !Array.isArray(c.dimensions) || c.dimensions.length === 0) return "";
  const lines = [];
  if (c.overview) lines.push(String(c.overview).trim());
  for (const d of c.dimensions) {
    const top = (Array.isArray(d.levels) ? d.levels : [])[0];
    lines.push(`【${d.name}】${d.description ? `${d.description}` : ""}`);
    for (const k of Array.isArray(d.criteria) ? d.criteria : []) lines.push(`- ${k}`);
    if (top && top.descriptor) lines.push(`- 「${top.label || "最高等级"}」要求：${top.descriptor}`);
  }
  return lines.join("\n");
}

// Goal categories the outline tags its goals with -- the template's own WHY
// fields (认知思维目标 / 实践技能目标 / ...); the goals writer files each goal
// under the matching field.
const GOAL_CATEGORIES = ["认知思维", "实践技能", "社会情感", "跨学科融合", "其它"];

// The outline's goals, with lesson assignments made complete in code -- not
// left to the model: every goal must be delivered by some lesson (an
// unassigned one goes to the lesson carrying the fewest goals), and each
// lesson's goalIds only name goals that exist. Mutates outlineLessons'
// goalIds; returns the goals.
function planGoals(outline, outlineLessons) {
  const goals = (Array.isArray(outline.goals) ? outline.goals : [])
    .map((g, i) => ({
      id: Number(g && g.id) || i + 1,
      category: GOAL_CATEGORIES.includes(g && g.category) ? g.category : "其它",
      text: asText(g && g.text),
    }))
    .filter((g) => g.text);
  const ids = new Set(goals.map((g) => g.id));
  for (const l of outlineLessons) {
    l.goalIds = (Array.isArray(l.goalIds) ? l.goalIds : []).map(Number).filter((id) => ids.has(id));
  }
  if (outlineLessons.length === 0) return goals;
  for (const g of goals) {
    if (outlineLessons.some((l) => l.goalIds.includes(g.id))) continue;
    const lightest = outlineLessons.reduce((a, b) => (b.goalIds.length < a.goalIds.length ? b : a));
    lightest.goalIds.push(g.id);
  }
  return goals;
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
  const criteria = standardBrief(deps.standard);

  // 1. research -----------------------------------------------------------
  emit({
    key: "research",
    label: `收集资料（模板 / 学习资源库 / 网络${deps.conversationDigest ? " / 对话要点" : ""}）`,
    status: "running",
  });
  const [template, library, web, teacherContext] = await Promise.all([
    deps.loadTemplate(),
    deps.searchLibrary(`「${title}」乡土课程设计（${grade || "小学"}）：主题背景、驱动问题与课程设计框架参考`).catch(() => null),
    deps.webSearch ? deps.webSearch(`${title} 历史 文化 特色 制作 习俗`).catch(() => null) : null,
    distillConversation(deps.conversationDigest, title).catch((e) => {
      console.error("起草课程设计：提炼对话要点失败（按无对话背景继续）:", e.message);
      return "";
    }),
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
    `${deps.school ? `\n学校与地区：${deps.school}（课程要立足当地；主题并非当地特产时，要设计与本地生活的联系或对比，而不是当作本地文化来写）` : ""}` +
    `${args.theme ? `\n乡土主题：${args.theme}` : ""}${requirements ? `\n教师的具体要求：${requirements}` : ""}` +
    `${teacherContext ? `\n对话中教师提供的背景与要求（务必遵守，尤其是需要避免的内容）：\n${teacherContext}` : ""}` +
    `${criteria ? `\n\n本系统评价课程设计所依据的标准（请按各维度最高等级的要求设计，各部分都要体现）：\n${criteria}` : ""}`;

  // 2. outline ------------------------------------------------------------
  emit({ key: "outline", label: "拟定课程大纲", status: "running" });
  const outline = await askJson(
    `${brief}\n\n可选乡土主题：${(template.themeOptions || []).join("、")}\n\n参考资料：\n${research || "（无）"}\n\n` +
      `请为这门课拟定大纲，按 PBL 流程（入项 → 探究 → 制作与迭代 → 出项）把 ${lessonCount} 个课时依次分配好。` +
      `同时确定 6-10 条总体学习目标（类别为：${GOAL_CATEGORIES.join("、")}），每条一句话、具体可落实，并为每条目标指定落实它的课时（goalIds）：` +
      "每条目标至少由一个课时落实，每个课时至少落实一条目标；只写这些课时确实能做到的目标——跨学科目标要对应课时里具体的学科活动（如某课时用称重计算配比），不要写课时里没有安排的内容。" +
      (criteria ? "目标的表述（包括需要标注的维度等）要满足评价标准中对目标设计的要求。" : "") +
      "严格只输出 JSON：" +
      `{"theme":"从可选乡土主题中选一个最贴切的，没有合适的留空","drivingQuestion":"儿童视角的驱动问题","finalProducts":"个人成果与团队成果，一句话",` +
      `"goals":[{"id":1,"category":"${GOAL_CATEGORIES[0]}","text":"目标"}],` +
      `"lessons":[{"index":1,"stage":"入项","title":"课时标题","focus":"本课时要做什么，一两句话","goalIds":[1]}]}`,
    2200
  );
  const outlineLessons = (Array.isArray(outline.lessons) ? outline.lessons : []).slice(0, lessonCount);
  while (outlineLessons.length < lessonCount) {
    outlineLessons.push({ index: outlineLessons.length + 1, stage: "", title: `第 ${outlineLessons.length + 1} 课时`, focus: "" });
  }
  outlineLessons.forEach((l, i) => {
    l.index = i + 1;
  });
  const goals = planGoals(outline, outlineLessons);
  emit({ key: "outline", status: "done" });

  const goalText = (g) => `目标${g.id}【${g.category}】${g.text}`;
  const outlineText =
    `驱动问题：${outline.drivingQuestion || ""}\n最终成果：${outline.finalProducts || ""}\n` +
    `${goals.length ? `总体学习目标：\n${goals.map(goalText).join("\n")}\n` : ""}课时安排：\n` +
    outlineLessons
      .map((l) => `第${l.index}课时【${l.stage || ""}】${l.title}：${l.focus || ""}${l.goalIds.length ? `（落实目标 ${l.goalIds.join("、")}）` : ""}`)
      .join("\n");
  const shared = `${brief}\n\n课程大纲：\n${outlineText}\n\n参考资料：\n${research || "（无）"}`;

  // 3. write, in parallel --------------------------------------------------
  // Overall fields split in two (goals + intro / the HOW stages) so neither
  // call is the long pole; each lesson is its own call.
  // One part per template section (WHY / WHAT / HOW ...): asking for all
  // the goals and the project intro in one reply ran past its output limit
  // and silently lost 9 of 10 fields (seen in a scored comparison).
  const sections = [];
  for (const f of planFields) {
    let sec = sections.find((x) => x.name === (f.section || ""));
    if (!sec) sections.push((sec = { name: f.section || "", fields: [] }));
    sec.fields.push(f);
  }
  const jobs = [
    ...sections.map((sec) => ({ kind: "fields", label: sec.name, fields: sec.fields })),
    ...outlineLessons.map((l) => ({ kind: "lesson", label: `第 ${l.index} 课时：${l.title}`, lesson: l })),
  ].filter((j) => j.kind === "lesson" || j.fields.length > 0);

  let doneCount = 0;
  const progressLabel = () => `并行撰写各部分（${doneCount}/${jobs.length}）`;
  emit({ key: "write", label: progressLabel(), status: "running" });
  const results = await mapLimit(jobs, WRITE_CONCURRENCY, async (job) => {
    let result;
    if (job.kind === "fields") {
      const isGoalSection = goals.length > 0 && job.fields.some((f) => /目标/.test(f.label)) && !job.fields.some((f) => f.group);
      const hasLessonPlan = job.fields.some((f) => f.group || /课时/.test(f.label + (f.hint || "")));
      // The goals section restates the outline's goals -- no new ones: a
      // goal added here is one no lesson was told to carry out (measured:
      // ~2 of ~18 goal items per draft went undelivered that way).
      const goalRule = isGoalSection
        ? `\n总体学习目标必须且只能是大纲中的这些目标（可以展开表述，但不要新增目标，也不要遗漏）；按类别写入对应字段，没有对应类别字段的写入「其它目标」：\n${goals.map(goalText).join("\n")}`
        : "";
      // Stage plans (课时安排) name the actual lessons, as numbered here.
      const lessonRule = hasLessonPlan
        ? `\n各阶段的课时安排必须与以下分课时完全一致（课时序号、标题与所属阶段）：\n${outlineLessons
            .map((l) => `第${l.index}课时【${l.stage || ""}】${l.title}`)
            .join("\n")}`
        : "";
      const ask = (fields) =>
        askJson(
          `${shared}\n\n请按大纲撰写以下课程设计字段的内容（每个字段 60-200 字，条理清楚，可分点；各字段内容互相衔接、与大纲一致）。${goalRule}${lessonRule}\n` +
            `严格只输出 JSON，键为字段 key，值为字段内容（字符串）：\n${fieldLines(fields)}`,
          3000
        );
      result = await ask(job.fields);
      // A reply cut short or keyed differently loses fields without any
      // error -- ask again for exactly what's missing.
      const missing = job.fields.filter((f) => !asText(result[f.key]));
      if (missing.length > 0) result = { ...result, ...(await ask(missing).catch(() => ({}))) };
    } else {
      const l = job.lesson;
      const assigned = goals.filter((g) => l.goalIds.includes(g.id));
      // What this lesson must deliver -- the other half of goal coverage.
      const assignedRule = assigned.length
        ? `本课时须落实以下总体目标：\n${assigned.map(goalText).join("\n")}\n教学目标要逐条体现这些目标在本课时的具体化，教学活动流程中要有落实每条目标的具体活动（跨学科目标要有具体的学科活动）。\n`
        : "";
      result = await askJson(
        `${shared}\n\n请详细撰写第 ${l.index} 课时（${l.stage ? `${l.stage}阶段，` : ""}「${l.title}」：${l.focus || ""}）的分课时设计。${assignedRule}` +
          `教学活动流程要分步骤并标注大致时长（共约 40 分钟）。严格只输出 JSON，键为字段 key，值为字段内容（字符串）：\n` +
          `${fieldLines(lessonFields)}\n其中 ${lessonFields[0] ? lessonFields[0].key : "f0"} 填「${l.title}（${l.stage || "PBL步骤"}）」。`,
        2200
      );
      const missing = lessonFields.filter((f) => !asText(result[f.key]));
      if (missing.length > 0) {
        const again = await askJson(
          `${shared}\n\n请为第 ${l.index} 课时（「${l.title}」）补写以下字段。严格只输出 JSON，键为字段 key，值为字段内容（字符串）：\n${fieldLines(missing)}`,
          1500
        ).catch(() => ({}));
        result = { ...result, ...again };
      }
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
    teacherContext,
    librarySources: (library && library.sources) || [],
    webSources: (web && web.webSources) || [],
  };
}

module.exports = { draftPlan, standardBrief };
