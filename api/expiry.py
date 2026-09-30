"""Demo uploads expire: a day after upload the file and its record go.

Only sidecars with a `visitors` map are uploads; a sample's sidecar has none
and is never touched. A sha two visitors uploaded lives until the last of them
expires. Derived artifacts are content addressed and unlisted, and are left to
the artifact store.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from api import demo
from api.routes.sources import META_DIR, SHA, _read_sidecar

log = logging.getLogger(__name__)


def _expired(stamp: str, now: datetime) -> bool:
    try:
        return now - datetime.fromisoformat(stamp) > demo.UPLOAD_TTL
    except (TypeError, ValueError):
        return True  # a record we cannot read is a record we do not keep


def sweep(sources: Path, now: datetime) -> int:
    """Drop expired owners; delete files nobody owns any more. Returns files deleted."""
    meta_dir = sources / META_DIR
    if not meta_dir.is_dir():
        return 0
    deleted = 0
    for meta in meta_dir.glob("*.json"):
        body = _read_sidecar(meta)
        visitors = body.get("visitors")
        if not visitors:
            continue
        kept = {v: t for v, t in visitors.items() if not _expired(t, now)}
        if kept:
            if kept != visitors:
                meta.write_text(json.dumps({**body, "visitors": kept}), encoding="utf-8")
            continue
        sha = body.get("sha")
        if isinstance(sha, str) and SHA.match(sha):
            for p in sources.glob(f"{sha}*"):
                if p.is_file() and not p.name.endswith(".part"):
                    p.unlink()
                    deleted += 1
        # a missing or invalid sha still gets its sidecar removed, so a
        # malformed record self-heals instead of being retried forever
        meta.unlink()
    return deleted


async def run_forever(sources: Path, interval_s: float = 3600) -> None:
    """Sweep now, then every `interval_s` seconds, until cancelled."""
    from datetime import timezone

    while True:
        try:
            n = await asyncio.to_thread(sweep, sources, datetime.now(timezone.utc))
            if n:
                log.info("expired %d upload(s)", n)
        except Exception:  # a broken sidecar must not stop the sweeper
            log.exception("upload sweep failed")
        await asyncio.sleep(interval_s)
