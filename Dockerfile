# ─────────────────────────────────────────────────────────────────────────────
# Romanian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t romanian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 romanian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/anspdcp.db.
# Override with ANSPDCP_DB_PATH for a custom location.
#
# Multi-stage to preserve better-sqlite3 native binding (postinstall builds
# the .node addon — must NOT be re-installed in production with --ignore-scripts).
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript and install full deps (with native bindings) ---
FROM node:20-slim AS builder

WORKDIR /app

# Install build toolchain for native modules (better-sqlite3 postinstall)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev deps but keep native bindings intact
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV ANSPDCP_DB_PATH=/app/data/anspdcp.db

# Copy production node_modules (with built better-sqlite3 binding) from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/ ./dist/

# Provision database (CI gunzips data/database.db.gz from release into data/database.db)
COPY data/database.db data/anspdcp.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
