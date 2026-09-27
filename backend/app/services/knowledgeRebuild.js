// (Re)builds the knowledge tree for material that already exists: every
// 学习资源库 file re-extracted page-aware and re-ingested exactly as an
// upload would (knowledge_chunks with page ranges + its
// knowledge_source_summaries node), every link / topic-meta source
// re-summarized from its existing chunks. Also picks up files that were
// never ingested at all. Shared by scripts/rebuildKnowledgeTree.js (whole
// library, from a shell) and 学习资源库's per-topic 重建资料索引 button
// (material-topic.controller.js#rebuildKnowledgeTree).
const fs = require("fs");
const db = require("../models");
const knowledgeIngest = require("./knowledgeIngest");
const knowledgeTree = require("./knowledgeTree");

async function rebuildSources({ topicId = null, summariesOnly = false, log = () => {} } = {}) {
  // Required lazily: the controller module pulls in multer/express bits a
  // service shouldn't load at require time.
  const { artifactKnowledgeSegments } = require("../controllers/material-artifact.controller");
  const where = topicId ? { materialTopicId: topicId } : {};
  const artifacts = await db.materialArtifact.findAll({ where, order: [["id", "ASC"]] });
  const links = await db.materialLink.findAll({ where, order: [["id", "ASC"]] });
  const topics = await db.materialTopic.findAll({ where: topicId ? { id: topicId } : {}, order: [["id", "ASC"]] });
  log(`文件 ${artifacts.length} 个，链接 ${links.length} 个，主题 ${topics.length} 个${summariesOnly ? "（仅重建摘要）" : ""}`);

  for (const a of artifacts) {
    const ref = { sourceType: "material_artifact", sourceId: a.id, materialTopicId: a.materialTopicId };
    const label = `文件 #${a.id} ${a.attachmentName}`;
    if (!summariesOnly && a.attachmentPath && fs.existsSync(a.attachmentPath)) {
      const segments = await artifactKnowledgeSegments(a.attachmentPath, a.type, a.category, a.description, a.attachmentName);
      const result = await knowledgeIngest.ingestSource({ ...ref, segments });
      if (result.written) {
        const pages = segments.filter((s) => s.page !== null).length;
        log(`✓ ${label}：${result.chunkCount} 段${pages ? `，${pages} 页` : ""}`);
        continue;
      }
      // Extraction yielded nothing -- ingestSource kept the old chunks;
      // still make sure they have a summary node.
    } else if (!summariesOnly) {
      log(`! ${label}：文件不存在，仅根据已有知识条目生成摘要`);
    }
    const s = await knowledgeTree.summarizeSource(ref);
    log(`${s ? "✓" : "-"} ${label}：${s ? "已生成摘要" : "无知识条目，跳过"}`);
  }

  for (const l of links) {
    const s = await knowledgeTree.summarizeSource({ sourceType: "material_link", sourceId: l.id, materialTopicId: l.materialTopicId });
    log(`${s ? "✓" : "-"} 链接 #${l.id}`);
  }

  for (const t of topics) {
    const s = await knowledgeTree.summarizeSource({ sourceType: "material_topic_meta", sourceId: t.id, materialTopicId: t.id });
    log(`${s ? "✓" : "-"} 主题基本信息 #${t.id} ${t.theme}`);
  }
}

// Per-topic "rebuild running" flags for the 学习资源库 button's polling --
// same idea as knowledgeIngest.js#isGenerating for skill cards.
const rebuilding = new Set();

function startTopicRebuild(topicId) {
  if (rebuilding.has(topicId)) return false;
  rebuilding.add(topicId);
  rebuildSources({ topicId })
    .then(() => knowledgeIngest.regenerateSkillCard(topicId))
    .catch((e) => console.error(`主题 #${topicId} 资料索引重建失败:`, e.message))
    .finally(() => rebuilding.delete(topicId));
  return true;
}

const isRebuilding = (topicId) => rebuilding.has(topicId);

module.exports = { rebuildSources, startTopicRebuild, isRebuilding };
