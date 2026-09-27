# Production image: install prod deps only, copy source, run directly (no hot reload).
FROM node:20-alpine

# node:20-alpine ships unzip (busybox applet) but not zip -- needed by
# artifact.controller.js's zip-download endpoints (downloadByPlan,
# downloadSelection), which shell out to the `zip` binary via child_process.
# mupdf-tools provides `mutool`, used by textExtract.js for PDF text
# extraction (native MuPDF -- far lighter than a JS PDF library; see that
# file's header comment for why).
RUN apk add --no-cache zip mupdf-tools

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Build identity (passed by scripts/deploy-aliyun.sh) -- declared after the
# npm ci layer so a new commit doesn't bust the dependency cache. Read by
# app/controllers/buildInfo.controller.js.
ARG BUILD_TAG=""
ARG BUILD_COMMIT=""
ARG BUILD_COMMIT_TIME=""
ARG BUILD_TIME=""
ENV BUILD_TAG=$BUILD_TAG BUILD_COMMIT=$BUILD_COMMIT BUILD_COMMIT_TIME=$BUILD_COMMIT_TIME BUILD_TIME=$BUILD_TIME

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
