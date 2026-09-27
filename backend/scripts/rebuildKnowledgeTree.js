// One-off / occasional: (re)builds the knowledge tree for material that
// already exists -- see services/knowledgeRebuild.js for exactly what that
// does. Idempotent; safe to re-run. Costs about one LLM call per
// non-trivial file.
//
//   docker compose exec backend node scripts/rebuildKnowledgeTree.js
//   docker compose exec backend node scripts/rebuildKnowledgeTree.js --topic 9
//   docker compose exec backend node scripts/rebuildKnowledgeTree.js --summaries-only
//   docker compose exec backend node scripts/rebuildKnowledgeTree.js --embeddings-only
//
// --summaries-only skips re-extraction and just (re)summarizes each source
// from the chunks already on file; --embeddings-only just embeds chunks
// that have no vector from the current EMBEDDING_MODEL yet.
const db = require("../app/models");
const { rebuildSources } = require("../app/services/knowledgeRebuild");

const args = process.argv.slice(2);
const topicId = args.includes("--topic") ? Number(args[args.indexOf("--topic") + 1]) : null;
const summariesOnly = args.includes("--summaries-only");
const embeddingsOnly = args.includes("--embeddings-only");

async function main() {
  await rebuildSources({ topicId, summariesOnly, embeddingsOnly, log: (line) => console.log(line) });
  if (embeddingsOnly) return;

  const summaries = await db.knowledgeSourceSummary.findAll({ where: topicId ? { materialTopicId: topicId } : {} });
  const rubrics = summaries.flatMap((s) =>
    (s.contents || []).filter((it) => it.kind === "rubric").map((it) => `《${s.title}》${it.label}`)
  );
  console.log(`\n完成：资料摘要 ${summaries.length} 个；识别出的评价标准 ${rubrics.length} 条：`);
  rubrics.forEach((r) => console.log(`  - ${r}`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
