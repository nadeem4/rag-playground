"""Check that a Space runs the commit just published to it.

    python scripts/verify_space.py --space nadeem4nk/rag-playground-staging --commit <sha>
    python scripts/verify_space.py --space nadeem4nk/rag-playground --commit <sha> --home --clip /clips/build.webm

Polls the Space's runtime until it is RUNNING and its /api/health reports the
commit that was published (a Space keeps serving the old build while the new
one builds, so RUNNING alone proves nothing). Fails at once on a build or
runtime error, and after --timeout seconds otherwise. --home checks the home
page answers 200; --clip checks a Home clip is a real video, not a Git LFS
pointer (the 2026-10-05 trap). A private Space needs HF_TOKEN in the
environment; it is sent as a bearer header to the Hub and to the Space.

Standard library only, so a workflow runs it without installing anything.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from typing import Callable

#: Stages after which the Space will not come up without a new publish.
FAILED = {"BUILD_ERROR", "RUNTIME_ERROR", "CONFIG_ERROR", "NO_APP_FILE"}
#: Smaller than this, a clip is a Git LFS pointer file, not a video.
MIN_CLIP_BYTES = 10_000


class DeployFailed(Exception):
    """The Space did not come up with the published commit."""


def space_host(space: str) -> str:
    """`owner/name` to its direct address, as Hugging Face names it."""
    owner, name = space.split("/", 1)
    return "https://" + re.sub(r"[^a-z0-9]+", "-", f"{owner}-{name}".lower()) + ".hf.space"


def wait_for_commit(
    stage: Callable[[], str],
    health: Callable[[], dict],
    commit: str,
    *,
    timeout: float,
    interval: float,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll until the Space is RUNNING and /api/health reports `commit`."""
    start = now()
    seen = "nothing yet"
    while True:
        current = stage()
        if current in FAILED:
            raise DeployFailed(f"The Space stopped with {current}. Its build or start logs on Hugging Face say why.")
        if current == "RUNNING":
            try:
                live = health().get("commit", "")
            except OSError as exc:  # not answering yet
                seen = f"no answer from /api/health ({exc})"
            else:
                if live == commit:
                    return
                seen = f"still running commit {live or 'unknown'}"
        else:
            seen = f"stage {current}"
        if now() - start >= timeout:
            raise DeployFailed(f"Gave up after {int(timeout)} s waiting for commit {commit}: {seen}.")
        sleep(interval)


def check_clip(size: int) -> None:
    if size < MIN_CLIP_BYTES:
        raise DeployFailed(f"The clip is {size} bytes: a Git LFS pointer, not the video. Check the Space's .gitattributes.")


def _get(url: str, token: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https hosts)
        return resp.status, resp.read()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--space", required=True, help="owner/name")
    parser.add_argument("--commit", required=True, help="the commit that was published")
    parser.add_argument("--timeout", type=float, default=1200, help="seconds to wait (default 20 minutes)")
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--home", action="store_true", help="check the home page answers 200")
    parser.add_argument("--clip", default="", help="a clip path to check is a real file, e.g. /clips/build.webm")
    args = parser.parse_args()
    token = os.environ.get("HF_TOKEN", "")
    host = space_host(args.space)

    def stage() -> str:
        try:
            _, body = _get(f"https://huggingface.co/api/spaces/{args.space}/runtime", token)
        except OSError as exc:
            return f"unknown ({exc})"
        return json.loads(body).get("stage", "unknown")

    def health() -> dict:
        _, body = _get(f"{host}/api/health", token)
        return json.loads(body)

    try:
        wait_for_commit(stage, health, args.commit, timeout=args.timeout, interval=args.interval)
        print(f"{args.space} is running commit {args.commit}.")
        if args.home:
            status, _ = _get(f"{host}/", token)
            if status != 200:
                raise DeployFailed(f"The home page answered {status}.")
            print("The home page answers 200.")
        if args.clip:
            _, body = _get(f"{host}{args.clip}", token)
            check_clip(len(body))
            print(f"{args.clip} is {len(body)} bytes.")
    except (DeployFailed, OSError) as exc:  # OSError: a check that got an error page or no answer
        print(f"Deploy check failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
