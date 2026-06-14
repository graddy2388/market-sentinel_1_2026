# ---- Build stage ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/

RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim

# Non-root user
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output from builder
COPY --from=builder /app/dist ./dist

# Data directory for SQLite (writable by appuser)
RUN mkdir -p /data && chown appuser:appgroup /data

ENV NODE_ENV=production
ENV DB_PATH=/data/data.db
ENV MCP_HOST=0.0.0.0

EXPOSE 3100

USER appuser

CMD ["node", "dist/interfaces/mcp/server.js"]
