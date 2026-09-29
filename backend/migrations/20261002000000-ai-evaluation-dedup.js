"use strict";

// One-time cleanup for the single source of truth (see
// app/services/aiPlanEvaluation.js): a plan has at most one AI score and
// one plan-scope AI review per (content version, standard). Before
// ensureEvaluation and its per-plan lock, the button and the batches could
// each write their own, leaving duplicates; this removes them.
//
// In each duplicate group:
//  - scores: the newest is kept;
//  - AI reviews: a review with a 欣欣助手 discussion (a chat conversation
//    scoped "review:<id>" that has messages) is never deleted -- the
//    teacher may have read and discussed it -- and the newest discussed one
//    is kept as the group's review; with no discussion, the newest is kept.
//    Conversations left with no messages on a deleted review go too.
//
// Every deleted row is first copied into a backup table
// (ai_dedup_backup_scores / ai_dedup_backup_reviews), so the cleanup can be
// undone; `down` restores the rows from them and drops them (the emptied
// conversations aren't restored -- they held no messages).
const SCORE_BACKUP = "ai_dedup_backup_scores";
const REVIEW_BACKUP = "ai_dedup_backup_reviews";

// Group key; NULL content versions/standards group together, as they do in
// the app's own "same content, same standard" comparison.
const groupKey = (r) => `${r.plan_id}|${r.plan_version_at ? new Date(r.plan_version_at).getTime() : "null"}|${r.standard_id ?? "null"}`;

function groupRows(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// The backup table must already exist: CREATE TABLE implicitly commits in
// MySQL, so it's created before the transaction (see up).
async function backupAndDelete(queryInterface, table, backup, ids, transaction) {
  if (ids.length === 0) return;
  const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
  await q(`INSERT IGNORE INTO ${backup} SELECT * FROM ${table} WHERE id IN (:ids)`, { ids });
  await q(`DELETE FROM ${table} WHERE id IN (:ids)`, { ids });
}

module.exports = {
  async up(queryInterface) {
    const select = (sql) => queryInterface.sequelize.query(sql, { type: queryInterface.sequelize.QueryTypes.SELECT });

    const scores = await select("SELECT id, plan_id, plan_version_at, standard_id FROM ai_plan_scores ORDER BY id DESC");
    const scoreIds = groupRows(scores).flatMap((g) => g.slice(1).map((r) => r.id)); // newest first -> keep g[0]

    const reviews = await select(
      "SELECT r.id, r.plan_id, r.plan_version_at, r.standard_id, " +
        "(SELECT COUNT(*) FROM chat_conversations c JOIN chat_messages m ON m.conversation_id = c.id " +
        " WHERE c.scope_key = CONCAT('review:', r.id)) AS discussion " +
        "FROM reviews r WHERE r.reviewer_type = 'ai' AND r.section_key IS NULL AND r.lesson_index IS NULL ORDER BY r.id DESC"
    );
    const reviewIds = groupRows(reviews).flatMap((g) => {
      const keep = g.find((r) => Number(r.discussion) > 0) || g[0];
      return g.filter((r) => r !== keep && Number(r.discussion) === 0).map((r) => r.id);
    });

    if (scoreIds.length) await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS ${SCORE_BACKUP} LIKE ai_plan_scores`);
    if (reviewIds.length) await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS ${REVIEW_BACKUP} LIKE reviews`);

    await queryInterface.sequelize.transaction(async (transaction) => {
      await backupAndDelete(queryInterface, "ai_plan_scores", SCORE_BACKUP, scoreIds, transaction);
      await backupAndDelete(queryInterface, "reviews", REVIEW_BACKUP, reviewIds, transaction);
      if (reviewIds.length) {
        await queryInterface.sequelize.query(
          "DELETE c FROM chat_conversations c LEFT JOIN chat_messages m ON m.conversation_id = c.id " +
            "WHERE m.id IS NULL AND c.scope_key IN (:keys)",
          { replacements: { keys: reviewIds.map((id) => `review:${id}`) }, transaction }
        );
      }
    });
    console.log(`AI 去重：删除重复打分 ${scoreIds.length} 条、重复 AI 点评 ${reviewIds.length} 条（已备份）。`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ n: hasScores }]] = await q(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${SCORE_BACKUP}'`);
    if (Number(hasScores)) {
      await q(`INSERT IGNORE INTO ai_plan_scores SELECT * FROM ${SCORE_BACKUP}`);
      await q(`DROP TABLE ${SCORE_BACKUP}`);
    }
    const [[{ n: hasReviews }]] = await q(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${REVIEW_BACKUP}'`);
    if (Number(hasReviews)) {
      await q(`INSERT IGNORE INTO reviews SELECT * FROM ${REVIEW_BACKUP}`);
      await q(`DROP TABLE ${REVIEW_BACKUP}`);
    }
  },
};
