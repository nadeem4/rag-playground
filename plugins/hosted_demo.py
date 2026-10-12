"""Whether the app runs as its hosted demo, for the app's own steps.

The same switch as `api.demo`, read here so `plugins` does not import `api`.
pandion never reads it: the app passes it in, as `public_only=` to
`pandion.llm`, and as `context_extras["public_endpoints_only"]` to every run
(`api.deps.Deps.run_extras`). On the demo a custom endpoint must then be a
public https address, and no message suggests setting a key on the server.
"""

from __future__ import annotations

import os

ENV_VAR = "RAG_PLAYGROUND_DEMO"


def enabled() -> bool:
    """Read on every call, so tests can flip it."""
    return os.environ.get(ENV_VAR) == "1"
