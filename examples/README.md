# Examples

One folder per package, to show how to use each one. Tests in `tests/integration/` run
them, so they stay in step with the code.

- [`pandion/`](pandion): Pandion used directly from Python, and the `pandion` command.
  Start here if your code is Python.
- [`pandion/extensions/`](pandion/README.md#extensions): a source, an access rule, an index store and a conversation store
  of your own, each with its test.
- [`pandion-api/`](pandion-api): Pandion served over HTTP by pandion-api, with a Python
  client and the same steps as curl commands. Start here if the code that needs Pandion
  is not Python, is a web app, or is one of several clients sharing a server. It also
  has `serve_policy.py`, a serve-mode Policy that checks a signed gateway token.
