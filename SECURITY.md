# Security policy

## Report a vulnerability

Please do not open a public issue for a security problem.

Report it privately with GitHub private vulnerability reporting:
https://github.com/nadeem4/rag-playground/security/advisories/new

Tell us what you found, the steps to reproduce it, and which version or URL you tested. We aim to reply within a week.

## Supported versions

We fix security problems in the latest release only:

- the latest RAG Playground app release,
- the latest `pandion` release on PyPI,
- the latest `pandion-api` release on PyPI.

If you use an older version, please upgrade first and check that the problem is still there.

## What is in scope

- The hosted demo.
- Uploads: how files are stored, who can read them, and how long they stay.
- Link fetching: for example, requests that reach internal addresses (SSRF).
- The API: `pandion-api` and the `/api/v2` routes of the app.
- The `pandion` package and its command line.

## What is out of scope

- Findings that need a stolen or shared API key.
- Denial of service by sending very large amounts of traffic.
- Problems in a model provider or in another package that we depend on. Please report those to the owner of that project.

## Your data on the demo

See [docs/privacy.md](docs/privacy.md) for what the hosted demo keeps and for how long.
