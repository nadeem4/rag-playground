# syntax=docker/dockerfile:1

# Stage 1: build the UI into web/dist.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: the Python server, which also serves the built UI.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

# opencv (pulled in by docling) needs these at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/data/hf \
    RAG_PLAYGROUND_SOURCES=/data/sources \
    RAG_PLAYGROUND_ARTIFACTS=/data/artifacts

WORKDIR /app

# Dependencies first, so a code change does not reinstall torch.
# uv.lock pins CPU-only torch on Linux.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY api/ api/
COPY core/ core/
COPY plugins/ plugins/
COPY providers/ providers/
COPY samples/ samples/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

COPY --from=web /web/dist web/dist

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data/hf /data/sources /data/artifacts \
    && chown -R app:app /data
USER app

EXPOSE 8000
CMD ["rag-playground", "--host", "0.0.0.0", "--no-browser"]
