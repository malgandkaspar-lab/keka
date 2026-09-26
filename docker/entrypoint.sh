#!/bin/sh
# Entrypoint: `web` (Next.js server), `worker` (BullMQ worker), `migrate` (DB migrations + seed data).
set -e
case "$1" in
  web)
    exec node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
    ;;
  worker)
    export SERVICE_NAME=shorts-factory-worker
    exec node_modules/.bin/tsx src/worker/index.ts
    ;;
  migrate)
    node_modules/.bin/prisma migrate deploy
    exec node_modules/.bin/tsx prisma/seed.ts
    ;;
  *)
    exec "$@"
    ;;
esac
