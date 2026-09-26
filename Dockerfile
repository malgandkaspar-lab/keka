# syntax=docker/dockerfile:1.7
# Shorts Factory - one image for the web app, the worker and the migration job.

# Node 22 from the official image on Ubuntu 24.04, which ships FFmpeg 6.1 (the version
# the render engine is tested against).
FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04 AS base
ENV NEXT_TELEMETRY_DISABLED=1 DEBIAN_FRONTEND=noninteractive
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation ca-certificates openssl tini bzip2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    FONTS_DIR=/usr/share/fonts/truetype \
    STORAGE_LOCAL_DIR=/app/storage \
    LOCAL_MODELS_DIR=/app/storage/models \
    WORK_DIR=/app/storage/tmp
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app/package.json /app/package-lock.json /app/tsconfig.json /app/next.config.ts /app/prisma.config.ts ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/src ./src
COPY --chown=app:app docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/storage && chown app:app /app/storage
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]
