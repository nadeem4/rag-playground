# Docs

Start with the group that matches what you are doing.

## Use the app

- [Guide](app/guide.md): every page of the web app in detail.
- [Strategies](app/strategies.md): every step and setting, and when to use each.
- [Models and keys](app/models-and-keys.md): the models the app downloads, the chat providers, and what happens to a key.
- [Privacy](privacy.md): what is kept, where and for how long.

## Use the Pandion package

- [The Pandion manual](pandion/index.md): install it, run a step, build a pipeline, index, search and ask.
- [Examples](../examples/README.md): tested scripts for Pandion and for pandion-api.
- [Write your own strategy](pandion/extend.md#write-your-own-strategy): add a step of your own.

## Run pandion-api or your own copy

- [pandion-api reference](pandion-api/index.md): Pandion over HTTP, the `Policy` and the routes.
- [Serve mode](pandion-api/serve-mode.md): serving one fixed pipeline to a site's users.
- [Deploy](operations/deploy.md): Docker, demo mode and running your own Hugging Face Space.
- [Configuration](operations/configuration.md): every environment variable and setting.
- [Privacy](privacy.md): what to tell your own users about their data.

## Work on the code

- [Contributing](../CONTRIBUTING.md): setup, tests, adding a strategy or an endpoint.
- [Architecture](architecture.md): the three layers, the pipeline, the cache and the run stream.
- [Lessons learned](lessons-learned.md): real pipeline problems, why each happened and what fixed it.
- [Release runbook](operations/release.md): staging, releasing, publishing Pandion and recording clips.
- [Security](../SECURITY.md) and [Code of conduct](../CODE_OF_CONDUCT.md).
