# TraceHub - Centralized Checkpoint Trace Collection
# https://muid.io | LifeAiTools Dev Team

FROM python:3.12-slim

LABEL maintainer="dev@lifeaitools.com"
LABEL description="TraceHub - Centralized checkpoint trace collection server"
LABEL version="0.1.0"

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

# Copy application code
COPY src/tracehub/ ./tracehub/

# Create data directory for SQLite persistence
RUN mkdir -p /data

# Environment defaults
ENV TRACEHUB_PORT=8099
ENV TRACEHUB_DB=/data/tracehub.db
ENV TRACEHUB_RETENTION_HOURS=72
ENV TRACEHUB_SECRET=""

EXPOSE 8099

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8099/health')" || exit 1

CMD ["python", "-m", "tracehub"]
