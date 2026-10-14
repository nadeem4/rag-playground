# The playground frontend

This is the website part of RAG Playground: the pages you see in the browser, such as
Home, Build, Compare, Evaluate, Library and Read. It is a React app written in TypeScript
and built with Vite. The Python server in [../backend/](../backend/README.md) serves the
built site and answers every request it makes.

## Run it in dev

You need Node.js 22. Start the server in one terminal from the root of the repo, then
start Vite in another:

```bash
uv run rag-playground --no-browser --reload
cd playground/frontend && npm install && npm run dev
```

Open http://localhost:5173. Vite sends every `/api` request to the server on
http://127.0.0.1:8000, so the page works the same as it does in production.

## How it talks to the server

The frontend talks to the server only over HTTP, with relative paths.

- Almost everything goes to [pandion-api](../../packages/pandion-api/README.md) under
  `/api/v2`: documents, runs, questions, evaluations, comparisons and key checks. The
  client is `src/api/v2.ts`.
- A few routes belong to the playground itself and sit under `/api`: the samples
  (`/api/samples`), the lessons (`/api/learn`), the question template and the app
  settings (`/api/settings/app`, which `src/api/useDemo.ts` reads once per page). They
  go through `src/api/client.ts`, except the samples, which have `src/api/samples.ts`.

A test guards this split. `src/api/oldRoutes.test.ts` fails if any source file names an
old `/api` route that has moved to `/api/v2`.

## Where state lives

The app's state is in `src/state`: the pipeline you are building, your saved pipelines,
the document you chose, Compare and Evaluate. The pipeline you are working on, your saved
pipelines and your saved experiments are kept in the browser's local storage, so they
stay on your machine.

## Scripts

- `npm run dev` starts the Vite dev server.
- `npm run build` checks the types and writes the site to `dist/`, which the server serves.
- `npm test` runs the tests once with Vitest.

`scripts/export_fixtures.py` makes the JSON fixtures in `src/api/fixtures/` from the real
engine. Run it from the root of the repo with
`uv run python playground/frontend/scripts/export_fixtures.py`.
