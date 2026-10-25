# RAG Playground

A local-first bench for learning RAG by experiment: see why a pipeline finds the answer, or misses it.

## Commands
- Setup: `uv sync --extra dev`, then `cd playground/frontend && npm install`
- Test: `uv run pytest` (fast), `uv run pytest -m models` (slow, loads models), `cd playground/frontend && npm test && npx tsc -b`
- Run: `uv run rag-playground --no-browser --reload` and `cd playground/frontend && npm run dev`, then open http://localhost:5173
- More (smoke tests, releases, adding a strategy or endpoint): CONTRIBUTING.md

## Layout
- packages/pandion: the engine, published to PyPI as `pandion`
- packages/pandion-api: the REST layer; uses only Pandion's public API
- playground/backend, playground/frontend: the app (FastAPI, Vite and React)
- tests/: the app's tests; each package has its own tests/
- docs/: public docs; examples/: tested usage examples; scripts/: release and recording tools

## Conventions
- Split every feature into its package part (Pandion, pandion-api) and its playground part, and build the package part first.
- Keep each PR under about 500 to 1,000 changed lines, split by concern.
- Add an entry to docs/lessons-learned.md for every real RAG pipeline fix, not for UI, cosmetic or deploy fixes.
- Linux is the source of truth for model output; check with the Release checks workflow.
- Releases ship staging's commit, and every release tag needs the owner's yes.
