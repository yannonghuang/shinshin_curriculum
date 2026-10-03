const db = require("../models");
const knowledgeTree = require("./knowledgeTree");
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

// The search_knowledge_base tool's executor for AI 点评 and 欣欣小助手:
// knowledge-tree retrieval (knowledgeTree.js#buildContext -- the model's
// query routed over topic/source summaries, relevant material returned
// verbatim within `budget`, the rest as summaries), topped up with the
// best FULLTEXT chunk hits the tree didn't already include -- routing works
// on meaning and can miss an exact term (a place name, a lecturer, a
// specific phrase) that plain keyword search catches.
//
// Returns { context, sources } -- `sources` ({ title, topic, locator }) is
// what copilot-panel.component.js's 参考资料 footer lists.
const KEYWORD_TOPUP_LIMIT = 3;

async function searchKnowledgeTree(
  query,
  { excludeCategories = [], includeTopicMeta = false, redact = false, budget = 8000 } = {}
) {
  const { text, provenance, usedChunkIds } = await knowledgeTree.buildContext({
    subject: query,
    excludeCategories,
    includeTopicMeta,
    redact,
    budget,
  });

  const sources = provenance
    ? [...provenance.anchors, ...provenance.verbatim, ...(provenance.semantic || []), ...provenance.summarized].map((x) => ({
        title: x.title,
        topic: x.topic,
        locator: x.locator || null,
      }))
    : [];

  // Keyword top-up: chunk-tier FULLTEXT hits not already in the tree
  // context, from topics the caller hasn't excluded.
  const used = new Set((usedChunkIds || []).map(String));
  const hits = (await searchKnowledgeBase(query, { limit: KEYWORD_TOPUP_LIMIT * 2 })).filter(
    (h) => h.tier === "chunk" && !used.has(String(h.chunkId))
  );
  const extra = [];
  const names = redact ? await knowledgeTree.loadPersonNames() : [];
  for (const h of hits) {
    if (extra.length >= KEYWORD_TOPUP_LIMIT) break;
    const topic = await db.materialTopic.findByPk(h.materialTopicId, { attributes: ["category", "theme"] });
    if (!topic || excludeCategories.includes(topic.category)) continue;
    if (h.sourceType === "material_topic_meta" && !includeTopicMeta) continue;
    const chunk = await db.knowledgeChunk.findByPk(h.chunkId, { attributes: ["pageFrom", "pageTo"] });
    const summary = await db.knowledgeSourceSummary.findOne({
      where: { sourceType: h.sourceType, sourceId: h.sourceId },
      attributes: ["title"],
    });
    const rawTitle = summary ? summary.title : h.sourceType === "material_topic_meta" ? "主题基本信息" : "资料";
    const title = redact ? knowledgeTree.redactNames(rawTitle, names) : rawTitle;
    const locator = chunk ? knowledgeTree.locatorOf([chunk]) : null;
    const topicLabel = `${topic.category} / ${topic.theme}`;
    extra.push(`《${title}》（${topicLabel}${locator ? `，${locator}` : ""}）：\n${h.content}`);
    sources.push({ title, topic: topicLabel, locator });
  }

  const blocks = [text, extra.length ? `【关键词匹配片段】\n\n${extra.join("\n\n")}` : ""].filter(Boolean);
  return {
    context: blocks.join("\n\n") || "学习资源库中未找到与该问题相关的资料。",
    sources,
  };
}

// OpenAI-style tool definition -- passed to agentLoop.js's `tools` array by
// both review.controller.js and chat.controller.js, alongside an executor
// that calls searchKnowledgeTree(args.query, ...). Owned here, not in
// agentLoop.js, so agentLoop.js stays fully generic and knows nothing about
// what tools exist.
const searchKnowledgeBaseToolDef = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "在共享学习资源库（乡土课程相关的讲座、课件、案例等资料）中查找与某个问题或任务相关的参考资料，" +
      "返回相关资料的原文段落（注明出处与页码）以及其他相关资料的摘要。" +
      "请用一句完整的话描述你要查找什么、用来做什么（例如“家乡美食主题课程的驱动问题设计案例”），" +
      "如果当前讨论的课程设计有具体主题、年级或学校/地区信息，建议纳入描述中。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或问题" },
      },
      required: ["query"],
    },
  },
};

module.exports = { searchKnowledgeBase, searchKnowledgeTree, searchKnowledgeBaseToolDef };
