# Apify Actor image. Build context = repo root of hypersignal-mcp/ so we can
# build the core and reuse it (single source of truth). Deploy with:
#   apify push   (run from apify-actor/, with build context set to ../)
FROM node:20-slim

WORKDIR /app

# Build the core package (produces ../dist consumed by the actor).
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build && npm prune --omit=dev

# Actor wrapper.
WORKDIR /app/apify-actor
COPY apify-actor/package.json ./
RUN npm install --no-audit --no-fund
COPY apify-actor/main.js ./
COPY apify-actor/.actor ./.actor

CMD ["node", "main.js"]
