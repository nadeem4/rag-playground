"""Demo mode, for a public host that strangers share (e.g. a Hugging Face Space).

On when `RAG_PLAYGROUND_DEMO=1`, read on every call so tests can flip it. In
demo mode: uploads are refused, the bundled samples are the only sources any
route lists or reads, and the Anthropic key comes only from the request header
(`api.credentials`), so a visitor never sees another visitor's file and never
spends the host's key.
"""

from __future__ import annotations

import os

ENV_VAR = "RAG_PLAYGROUND_DEMO"

NO_UPLOADS = (
    "uploads are disabled in this hosted demo; run the playground locally "
    "to use your own PDFs"
)


def enabled() -> bool:
    return os.environ.get(ENV_VAR) == "1"


def readable(sha: str | None) -> bool:
    """May a request read the source with this sha? Outside demo mode, any."""
    from api import sample_set

    return not enabled() or sha in sample_set.readable_shas()
