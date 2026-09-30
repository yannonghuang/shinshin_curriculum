"use strict";

// One-time cleanup: a plan keeps only its latest AI evaluation. Since
// aiPlanEvaluation.js replaces a plan's older AI score/review whenever a new
// one is written, older rows only survive from before that rule -- this
// removes them, so every plan carries just its newest score and newest
// plan-scope AI review.
//
//  - scores: each plan's newest is kept;
//  - AI reviews (计划整体点评): each plan's newest is kept, and so is any
//    older one with a 欣欣助手 discussion (a chat conversation scoped
//    "review:<id>" with messages) -- the same exception the app applies;
//    message-less conversations of deleted reviews go too.
//
// Deleted rows are first copied into backup tables
// (ai_prune_backup_scores / ai_prune_backup_reviews); `down` restores them
// and drops the tables.
const SCORE_BACKUP = "ai_prune_backup_scores";
const REVIEW_BACKUP = "ai_prune_backup_reviews";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const select = (sql) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });

    const scoreIds = (
      await select(
        "SELECT s.id FROM ai_plan_scores s WHERE EXISTS (SELECT 1 FROM ai_plan_scores s2 WHERE s2.plan_id = s.plan_id AND s2.id > s.id)"
      )
    ).map((r) => r.id);

    const planScope = "r.reviewer_type = 'ai' AND r.section_key IS NULL AND r.lesson_index IS NULL";
    const reviewIds = (
      await select(
        `SELECT r.id FROM reviews r WHERE ${planScope} ` +
          "AND EXISTS (SELECT 1 FROM reviews r2 WHERE r2.plan_id = r.plan_id AND r2.reviewer_type = 'ai' " +
          "  AND r2.section_key IS NULL AND r2.lesson_index IS NULL AND r2.id > r.id) " +
          "AND NOT EXISTS (SELECT 1 FROM chat_conversations c JOIN chat_messages m ON m.conversation_id = c.id " +
          "  WHERE c.scope_key = CONCAT('review:', r.id))"
      )
    ).map((r) => r.id);

    // CREATE TABLE implicitly commits in MySQL, so the backup tables are
    // created before the transaction.
    if (scoreIds.length) await sequelize.query(`CREATE TABLE IF NOT EXISTS ${SCORE_BACKUP} LIKE ai_plan_scores`);
    if (reviewIds.length) await sequelize.query(`CREATE TABLE IF NOT EXISTS ${REVIEW_BACKUP} LIKE reviews`);

    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { replacements, transaction });
      if (scoreIds.length) {
        await q(`INSERT IGNORE INTO ${SCORE_BACKUP} SELECT * FROM ai_plan_scores WHERE id IN (:ids)`, { ids: scoreIds });
        await q("DELETE FROM ai_plan_scores WHERE id IN (:ids)", { ids: scoreIds });
      }
      if (reviewIds.length) {
        await q(`INSERT IGNORE INTO ${REVIEW_BACKUP} SELECT * FROM reviews WHERE id IN (:ids)`, { ids: reviewIds });
        await q("DELETE FROM reviews WHERE id IN (:ids)", { ids: reviewIds });
        await q(
          "DELETE c FROM chat_conversations c LEFT JOIN chat_messages m ON m.conversation_id = c.id " +
            "WHERE m.id IS NULL AND c.scope_key IN (:keys)",
          { keys: reviewIds.map((id) => `review:${id}`) }
        );
      }
    });
    console.log(`AI 旧版清理：删除旧打分 ${scoreIds.length} 条、旧 AI 点评 ${reviewIds.length} 条（已备份）。`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const exists = async (table) => {
      const [[{ n }]] = await q(
        `SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
      );
      return Number(n) > 0;
    };
    if (await exists(SCORE_BACKUP)) {
      await q(`INSERT IGNORE INTO ai_plan_scores SELECT * FROM ${SCORE_BACKUP}`);
      await q(`DROP TABLE ${SCORE_BACKUP}`);
    }
    if (await exists(REVIEW_BACKUP)) {
      await q(`INSERT IGNORE INTO reviews SELECT * FROM ${REVIEW_BACKUP}`);
      await q(`DROP TABLE ${REVIEW_BACKUP}`);
    }
  },
};
