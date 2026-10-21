const fs = require("fs");
const db = require("../models");
const Plan = db.plan;
const Artifact = db.artifact;
const Review = db.review;
const Op = db.Sequelize.Op;

// How long a deleted plan stays in the 回收站 before purgeExpired removes it
// for good. Restoring within this window brings back everything -- the plan
// row was only stamped deleted_at (plan.model.js's paranoid mode), its
// children and files were never touched.
const TRASH_RETENTION_DAYS = 30;

const purgeAt = (deletedAt) => new Date(new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

// The old hard delete: plan row + its reviews/artifacts (folders and AI
// scores go via ON DELETE CASCADE) in one transaction, then the attachment
// files on disk once that's committed. Only ever called on a plan already
// in the 回收站 -- from the 永久删除 button or purgeExpired below.
async function purgePlan(id) {
  const t = await db.sequelize.transaction();
  let artifactPaths;
  try {
    const artifacts = await Artifact.findAll({
      where: { planId: id },
      attributes: ["id", "attachmentPath"],
      transaction: t,
    });
    artifactPaths = (artifacts || []).map((x) => x.attachmentPath).filter(Boolean);

    // Application-level cascade for compatibility even if DB FK is missing.
    await Review.destroy({ where: { planId: id }, transaction: t });
    await Artifact.destroy({ where: { planId: id }, transaction: t });
    await Plan.destroy({ where: { id }, force: true, transaction: t });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  for (const filePath of artifactPaths) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error("删除附件文件失败:", filePath, e.message);
    }
  }
}

// Run daily from server.js, alongside the chat retention sweep. One plan at
// a time (each in its own transaction) so one bad row doesn't block the rest.
async function purgeExpired() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await Plan.findAll({
    where: { deletedAt: { [Op.lt]: cutoff } },
    attributes: ["id"],
    paranoid: false,
  });
  let purged = 0;
  for (const { id } of expired) {
    try {
      await purgePlan(id);
      purged += 1;
    } catch (err) {
      console.error(`Plan trash sweep: failed to purge plan ${id}:`, err.message);
    }
  }
  return purged;
}

module.exports = { TRASH_RETENTION_DAYS, purgeAt, purgePlan, purgeExpired };
