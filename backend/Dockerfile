# Production image: install prod deps only, copy source, run directly (no hot reload).
FROM node:20-alpine

# node:20-alpine ships unzip (busybox applet) but not zip -- needed by
# artifact.controller.js's zip-download endpoints (downloadByPlan,
# downloadSelection), which shell out to the `zip` binary via child_process.
RUN apk add --no-cache zip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
