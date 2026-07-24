# Self-contained Apify Actor image. Build context is the apify-actor/ folder
# (what `apify push` provides), so it copies ONLY files from here — no parent
# monorepo build. The analytics run on your deployed MCP server; this Actor
# just proxies to it and charges per event.
FROM apify/actor-node:20

# Install deps first for layer caching.
COPY package.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --no-audit --no-fund \
 && echo "Installed dependencies:" && (npm ls --omit=dev || true)

# Copy the rest of the actor (main.js, .actor/).
COPY . ./

CMD ["node", "main.js"]
