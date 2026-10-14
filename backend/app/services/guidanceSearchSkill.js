// 指导检索 skill -- finds the rules a province applies to 课外读物 entering
// schools: the national baseline (教育部《中小学生课外读物进校园管理办法》,
// 2021) plus whatever the province's 教育厅 has issued on top (实施细则,
// 推荐书目, 负面清单, 图书馆配备/剔旧 requirements). Web search only
// (llmClient.webSearch), then the model distills the summaries into a
// structured rule set. Cached per province in reading_guidances and renewed
// once older than TTL_MS (or on demand). Self-improving via skillNotes.js,
// like bookSearchSkill.js.
const db = require("../models");
const llmClient = require("./llmClient");
const skillNotes = require("./skillNotes");
const { STAGE_KEYS } = require("../constants/readingStages");

const SKILL = "guidance_search";
const SKILL_PURPOSE =
  "联网检索教育部及各省（自治区、直辖市）教育主管部门关于中小学课外读物进校园的管理规定、推荐原则、负面清单（红线）和分学段要求。";

const TTL_MS = 180 * 24 * 60 * 60 * 1000;

const isFresh = (row) => !!row && Date.now() - new Date(row.fetchedAt).getTime() < TTL_MS;

const searchesFor = (province) => [
  {
    label: "国家规定",
    prompt:
      "请联网检索教育部2021年印发的《中小学生课外读物进校园管理办法》，用中文准确总结：推荐原则与标准、" +
      "严禁进入校园的课外读物情形（逐条列出）、对不同学段学生的要求、推荐程序与责任主体。",
  },
  {
    label: "省级规定",
    prompt:
      `请联网检索${province}教育厅（或教育主管部门）关于中小学课外读物进校园管理的实施细则、通知或办法，` +
      "以及该省发布的中小学生课外阅读推荐书目、负面清单、地方特别要求（如民族团结、地方文化等）。" +
      `用中文准确总结文件名称、发文机关、年份和主要条款。如果没有找到${province}的专门文件，请明确说明“未找到省级文件”。`,
  },
  {
    label: "图书配备",
    prompt:
      `请联网检索${province}关于中小学图书馆（室）图书配备、复本、剔旧清理、不适宜读物排查的规定或通知，` +
      "以及教育部《中小学图书馆（室）规程》中关于馆藏图书的要求。用中文准确总结要点和文件名称。",
  },
];

async function distill(province, findings) {
  const result = await llmClient.llmChat({
    systemPrompt:
      `你在为${province}的中小学整理课外读物进校园的合规依据。根据联网检索摘要，提炼出结构化规则，` +
      "只依据摘要内容，不要编造文件或条款；省级内容只写摘要中确有的。" +
      "redLines：禁止进校园的读物情形（每条一句话，尽量保留原文措辞）；principles：推荐原则与标准；" +
      `stageGuidance：各学段（${STAGE_KEYS.join("、")}，分别指1—2、3—4、5—6、7—9年级）的阅读要求或适读特点，没有则留空字符串；` +
      "localNotes：本省特有的要求或推荐书目信息；hasProvincialRules：是否找到了本省的专门文件。" +
      '只输出 JSON：{"documents": [{"title": "", "issuer": "", "year": "", "level": "国家|省级"}], "principles": [""], "redLines": [""], ' +
      `"stageGuidance": {${STAGE_KEYS.map((k) => `"${k}": ""`).join(", ")}}, "localNotes": [""], "hasProvincialRules": false}`,
    messages: [{ role: "user", content: findings.map((f) => `【${f.label}】\n${f.text}`).join("\n\n") }],
    maxTokens: 3000,
    thinking: false,
  });
  const p = skillNotes.parseJsonObject(result.text);
  const stageGuidance = {};
  STAGE_KEYS.forEach((k) => (stageGuidance[k] = String((p.stageGuidance && p.stageGuidance[k]) || "").trim()));
  return {
    content: {
      documents: (Array.isArray(p.documents) ? p.documents : [])
        .map((d) => ({
          title: String(d.title || "").trim(),
          issuer: String(d.issuer || "").trim(),
          year: String(d.year || "").trim(),
          level: String(d.level || "").trim(),
        }))
        .filter((d) => d.title),
      principles: skillNotes.strList(p.principles),
      redLines: skillNotes.strList(p.redLines),
      stageGuidance,
      localNotes: skillNotes.strList(p.localNotes),
      hasProvincialRules: p.hasProvincialRules === true,
    },
    model: result.model,
  };
}

async function fetchGuidance(province) {
  const notes = await skillNotes.notesPrompt(SKILL);
  const findings = [];
  for (const s of searchesFor(province)) {
    const r = await llmClient.webSearch({ prompt: `${s.prompt}检索结果中没有的信息不要补充或推测。${notes}`, maxTokens: 2000 });
    findings.push({ label: s.label, text: r.text || "", sources: (r.sources || []).slice(0, 8) });
  }
  const { content, model } = await distill(province, findings);
  if (content.redLines.length === 0) throw new Error(`未能检索到${province}的课外读物管理规定，请稍后重试。`);

  const sources = findings.flatMap((f) => f.sources.map((s) => ({ title: s.title, url: s.url, site: s.site, topic: f.label })));
  const values = { province, content, sources, aiModel: model, fetchedAt: new Date() };
  const existing = await db.readingGuidance.findOne({ where: { province } });
  const row = existing ? await existing.update(values) : await db.readingGuidance.create(values);

  skillNotes.reviseNotes(SKILL, {
    skillPurpose: SKILL_PURPOSE,
    experience:
      `省份：${province}\n` +
      findings
        .map((f) => `检索「${f.label}」：来源网站 ${[...new Set(f.sources.map((s) => s.site).filter(Boolean))].join("、") || "无"}`)
        .join("\n") +
      `\n提炼结果：文件 ${content.documents.map((d) => `${d.level}《${d.title}》`).join("、") || "无"}；红线 ${content.redLines.length} 条；` +
      `${content.hasProvincialRules ? "找到了省级专门文件" : "未找到省级专门文件"}。`,
  });
  return row;
}

// One fetch per province at a time -- concurrent runs for the same province
// share it.
const inFlight = new Map();

async function getGuidance(province, { force = false } = {}) {
  if (!force) {
    const row = await db.readingGuidance.findOne({ where: { province } });
    if (isFresh(row)) return row;
  }
  if (!inFlight.has(province)) {
    inFlight.set(
      province,
      fetchGuidance(province).finally(() => inFlight.delete(province))
    );
  }
  return inFlight.get(province);
}

const isRefreshing = (province) => inFlight.has(province);

module.exports = { SKILL, getGuidance, isRefreshing, TTL_MS };
