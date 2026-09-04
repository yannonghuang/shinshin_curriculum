#!/bin/sh
# Runs once per container start, before the app -- see ALIYUN_DEPLOY.md and
# deploy.md for the migration workflow this replaces (SSH in, ALTER TABLE by
# hand). SKIP_MIGRATIONS=true is an escape hatch to get the app running while
# a bad migration is fixed by hand, without editing this script on the VM.
set -e

if [ "${SKIP_MIGRATIONS:-}" != "true" ]; then
  echo "==> Running database migrations..."
  npx sequelize-cli db:migrate
fi

exec "$@"
