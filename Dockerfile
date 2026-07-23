# HyperSignal MCP — remote HTTP server image.
# Multi-stage: compile TS + native deps once in `build`, ship a slim runtime
# with no compiler toolchain (node_modules, incl. prebuilt better-sqlite3,
# are copied from the build stage — same base image, ABI-compatible).
FROM node:20-slim AS build
WORKDIR /app
# Build toolchain for native better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
# npm ci: reproducible builds strictly from the committed lockfile.
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY .env.example ./.env.example
RUN mkdir -p /app/data
EXPOSE 8080
# Default to the remote HTTP server (free + premium; never trading).
CMD ["node", "dist/server-http.js"]
