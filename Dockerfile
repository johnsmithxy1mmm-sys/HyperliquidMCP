# HyperSignal MCP — remote HTTP server image.
# Multi-stage: build TypeScript, then run a slim production image.
FROM node:20-slim AS build
WORKDIR /app
# Build toolchain for native better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Route Node's built-in fetch through an HTTPS_PROXY if one is set (Node >= 22 no-op otherwise).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY .env.example ./.env.example
RUN mkdir -p /app/data
EXPOSE 8080
# Default to the remote HTTP server (free + premium; never trading).
CMD ["node", "dist/server-http.js"]
