// Super-only build/deploy identity for the app's build-info footer -- which
// commit is live, when it was built, and when this server process started
// (≈ when it was last deployed/restarted). BUILD_* come from the image's
// build args (see backend/Dockerfile and scripts/deploy-aliyun.sh); a dev
// container has none, so tag is null there.
const db = require("../models");

const STARTED_AT = new Date();

exports.get = async (req, res) => {
  try {
    // Newest applied migration -- migrations are timestamp-prefixed, so the
    // lexically last name is the latest one. Confirms a deploy's schema
    // changes actually applied, not just that the code is new.
    let latestMigration = null;
    try {
      const rows = await db.sequelize.query("SELECT name FROM SequelizeMeta ORDER BY name DESC LIMIT 1", {
        type: db.QueryTypes.SELECT,
      });
      latestMigration = rows[0] ? rows[0].name.replace(/\.js$/, "") : null;
    } catch (e) {
      latestMigration = null;
    }

    return res.send({
      tag: process.env.BUILD_TAG || null,
      commit: process.env.BUILD_COMMIT || null,
      commitTime: process.env.BUILD_COMMIT_TIME || null,
      buildTime: process.env.BUILD_TIME || null,
      startedAt: STARTED_AT,
      latestMigration,
      nodeEnv: process.env.NODE_ENV || "development",
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询版本信息时发生错误。" });
  }
};
