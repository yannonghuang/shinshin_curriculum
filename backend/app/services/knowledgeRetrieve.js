const db = require("../models");
const { QueryTypes } = db.Sequelize;

// FULLTEXT search against the two-tier KB: knowledge_skills (curated cards)
// first, knowledge_chunks (raw extracted text, broader/fallback recall)
// second -- results are labeled by tier so a caller (or the model itself, via
// the tool description below) can weigh curated hits over raw ones.
//
// BOOLEAN MODE, not NATURAL LANGUAGE MODE: natural-language mode silently
// zeroes out any term that appears in more than 50% of rows (a stopword-like
// relevance rule tuned for large corpora) -- at this app's expected scale
// (an admin-curated regional library, easily small enough for a handful of
// skill cards to share common vocabulary), that threshold can suppress
// exactly the terms a small KB most needs to match on. Boolean mode has no
// such cutoff; with no +/-/"" operators in the query it still behaves as a
// plain OR-across-terms search, just without the 50% trap. `WITH PARSER
// ngram` (set on the indexes themselves, see the migration) tokenizes both
// the indexed content and the search string into 2-char windows, which is
// what makes this work for Chinese at all -- MySQL's default parser only
// splits on whitespace, which Chinese text doesn't have.
async function searchKnowledgeBase(query, { materialTopicId, limit = 5 } = {}) {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const topicFilter = materialTopicId ? "AND material_topic_id = :materialTopicId" : "";
  const replacements = { query: trimmed, limit, materialTopicId };

  const skillRows = await db.sequelize.query(
    `SELECT id, material_topic_id, title, summary, key_points, tags,
            MATCH(title, summary) AGAINST (:query IN BOOLEAN MODE) AS score
     FROM knowledge_skills
     WHERE MATCH(title, summary) AGAINST (:query IN BOOLEAN MODE) ${topicFilter}
     ORDER BY score DESC
     LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const chunkRows = await db.sequelize.query(
    `SELECT id, material_topic_id, source_type, source_id, content,
            MATCH(content) AGAINST (:query IN BOOLEAN MODE) AS score
     FROM knowledge_chunks
     WHERE MATCH(content) AGAINST (:query IN BOOLEAN MODE) ${topicFilter}
     ORDER BY score DESC
     LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const skills = skillRows.map((r) => ({
    tier: "skill",
    skillId: r.id,
    materialTopicId: r.material_topic_id,
    title: r.title,
    content: r.summary,
    keyPoints: r.key_points,
    tags: r.tags,
    score: r.score,
  }));

  const chunks = chunkRows.map((r) => ({
    tier: "chunk",
    chunkId: r.id,
    materialTopicId: r.material_topic_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    content: r.content,
    score: r.score,
  }));

  return [...skills, ...chunks];
}

// OpenAI-style tool definition -- passed to agentLoop.js's `tools` array by
// both review.controller.js and chat.controller.js, alongside an executor
// that just calls searchKnowledgeBase(args.query). Owned here, not in
// agentLoop.js, so agentLoop.js stays fully generic and knows nothing about
// what tools exist.
const searchKnowledgeBaseToolDef = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "在共享学习材料库（乡土课程相关的知识卡片与已上传材料内容）中检索与某个问题或主题相关的参考资料。" +
      "如果当前讨论的课程设计有具体主题、年级或学校/地区信息，建议将其关键词纳入检索词中，以便优先找到与该主题或地区最相关的资料。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或问题" },
      },
      required: ["query"],
    },
  },
};

module.exports = { searchKnowledgeBase, searchKnowledgeBaseToolDef };
