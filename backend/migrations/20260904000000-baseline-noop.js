"use strict";

// Anchor migration, deliberately a no-op. Everything up to this point --
// every table in schema.sql, plus every ALTER TABLE run by hand against
// local dev and production before this migration system existed -- is
// already live on both databases. Rather than translate schema.sql into an
// executable migration (risking drift from what's actually running, and
// needing a manual SequelizeMeta seed on the databases already at that
// state), this migration does nothing and is safe to run for real on any
// database, fresh or existing: a fresh install already got the full schema
// from schema.sql via docker-entrypoint-initdb.d before the app container's
// entrypoint ever runs db:migrate. Its only job is to exist, so every
// migration added after it has a real baseline to build on.
module.exports = {
  async up() {},
  async down() {},
};
