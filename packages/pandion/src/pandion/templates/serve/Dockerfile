FROM python:3.13-slim@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1
COPY --from=ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc /uv /usr/local/bin/uv

# The same HF_HOME at build and at run, so the models pulled below are the ones the server loads.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    HF_HOME=/models/hf \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

# uv.lock is yours: run `uv lock` once and commit it. The build fails without it.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY pipeline.yaml serve.py policy.py ./
# Public weights only, no secret. At run time pipeline.yaml says download: never.
RUN pandion models pull pipeline.yaml

RUN useradd --create-home app && mkdir -p /app/index && chown -R app /app /models
USER app
EXPOSE 8000
CMD ["uvicorn", "serve:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
