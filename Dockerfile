FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src/ src/

# Data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/data.db

EXPOSE 3100

CMD ["node", "--import", "tsx", "src/interfaces/mcp/server.ts"]
