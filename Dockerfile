FROM node:24-slim

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
ENV PORT=3721
ENV FABRICA_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3721
# Run node directly so SIGTERM reaches the server, which finishes calls in flight before it exits.
CMD ["node", "--import", "tsx", "server/main.ts"]
