"""Demo mode, for a public host that strangers share (e.g. a Hugging Face Space).

On when `RAG_PLAYGROUND_DEMO=1`, read on every call so tests can flip it. In
demo mode: uploads are refused, the bundled sample is the only source any route
lists or reads, and the Anthropic key comes only from the request header
(`api.credentials`), so a visitor never sees another visitor's file and never
spends the host's key.
"""

from __future__ import annotations

import hashlib
import os
from functools import cache
from pathlib import Path

ENV_VAR = "RAG_PLAYGROUND_DEMO"

#: The first-run sample, committed to the repo and made by
#: `scripts/make_sample_pdf.py`.
SAMPLE_PDF = Path(__file__).resolve().parents[1] / "samples" / "chunking-primer.pdf"

NO_UPLOADS = (
    "uploads are disabled in this hosted demo; run the playground locally "
    "to use your own PDFs"
)


def enabled() -> bool:
    return os.environ.get(ENV_VAR) == "1"


@cache
def sample_sha() -> str:
    return hashlib.sha256(SAMPLE_PDF.read_bytes()).hexdigest()


def readable(sha: str | None) -> bool:
    """May a request read the source with this sha? Outside demo mode, any."""
    return not enabled() or sha == sample_sha()
