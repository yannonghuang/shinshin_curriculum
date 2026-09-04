# Production image: install prod deps only, copy source, run directly (no hot reload).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
CMD ["node", "server.js"]
