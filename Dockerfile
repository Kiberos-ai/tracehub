# TracHub - Centralized Checkpoint Trace Collection
# https://muid.io | LifeAiTools Dev Team

FROM oven/bun:slim AS base
WORKDIR /app

LABEL maintainer="dev@lifeaitools.com"
LABEL description="TracHub - Centralized checkpoint trace collection server"
LABEL version="1.0.0"

# Install deps (bunfig.toml maps the @context777 scope to npm.muid.io)
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY drizzle.config.ts ./

# Data dir
RUN mkdir -p /data

# Env defaults
ENV TRACEHUB_PORT=8099
ENV TRACEHUB_DB=/data/tracehub.db
ENV TRACEHUB_RETENTION_HOURS=72
ENV TRACEHUB_SECRET=""

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:8099/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

CMD ["bun", "run", "src/index.ts"]
