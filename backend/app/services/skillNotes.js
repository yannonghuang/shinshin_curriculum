// Self-improvement for the 课外读物推荐 skills (bookSearchSkill.js,
// guidanceSearchSkill.js). Each skill keeps a short list of lessons --
// which search phrasings and sites worked, what to watch out for -- in
// agent_skill_notes. The list goes into the skill's next prompt, and after
// a run the skill hands reviseNotes() what happened (hits, misses, sources
// that answered) so the model can fold that experience back in. Kept small
// (MAX_NOTES) so it stays a sharp prompt, not an ever-growing log.
const db = require("../models");
const llmClient = require("./llmClient");

const MAX_NOTES = 15;

const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s || "").trim()).filter(Boolean) : []);

const parseJsonObject = (raw) => {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 回复中没有 JSON");
  return JSON.parse(text.slice(start, end + 1));
};

async function getNotes(skill) {
  const row = await db.agentSkillNotes.findOne({ where: { skill } });
  return row ? { notes: strList(row.notes), revision: row.revision, updatedAt: row.updatedAt } : { notes: [], revision: 0, updatedAt: null };
}

// "以往经验" block for a skill's prompt -- empty when it has none yet.
async function notesPrompt(skill) {
  const { notes } = await getNotes(skill);
  if (notes.length === 0) return "";
  return `\n\n【以往经验（请参考）】\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
}

// `skillPurpose`: one line on what the skill does; `experience`: a plain-text
// account of this run. Never throws -- a failed reflection just leaves the
// notes as they were.
async function reviseNotes(skill, { skillPurpose, experience }) {
  try {
    const current = await getNotes(skill);
    const result = await llmClient.llmChat({
      systemPrompt:
        `你在维护一个AI技能的经验笔记。该技能：${skillPurpose}\n` +
        "根据本次运行情况，更新经验笔记：保留仍然有用的条目，合并重复，删去被证明无效的，补充新的可操作经验" +
        "（例如哪些检索词写法、哪些网站更容易找到结果、哪些情况需要注意）。每条一句话，具体、可执行，" +
        `最多 ${MAX_NOTES} 条。只依据本次运行情况与已有笔记，不要编造。` +
        '只输出 JSON：{"notes": ["..."]}',
      messages: [
        {
          role: "user",
          content:
            `【已有经验笔记】\n${current.notes.length ? current.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "（暂无）"}\n\n` +
            `【本次运行情况】\n${experience}`,
        },
      ],
      maxTokens: 1500,
      thinking: false,
    });
    const notes = strList(parseJsonObject(result.text).notes).slice(0, MAX_NOTES);
    if (notes.length === 0) return;
    const [row] = await db.agentSkillNotes.findOrCreate({ where: { skill }, defaults: { skill, notes: [], revision: 0 } });
    await row.update({ notes, revision: row.revision + 1 });
  } catch (e) {
    console.warn(`技能经验笔记更新失败（${skill}）：${e.message}`);
  }
}

module.exports = { getNotes, notesPrompt, reviseNotes, parseJsonObject, strList };
