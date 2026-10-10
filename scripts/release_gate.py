"""The production gate, run as the first step of a production publish.

    python scripts/release_gate.py --tag v0.33.0 --commit <sha> --repo nadeem4/rag-playground
    python scripts/release_gate.py --commit <sha> --repo nadeem4/rag-playground   # before tagging

Two rules, both from the owner:
- Production takes only a plain version tag, vX.Y.Z.
- The tag's commit must have passed a staging publish: the staging workflow
  marks a verified commit with the GitHub commit status `staging` = success,
  and the newest `staging` status on the commit must be a success.

The commit's statuses are read from the GitHub API with GITHUB_TOKEN (or
GH_TOKEN). Standard library only, so a workflow runs it without installing anything.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request

RELEASE = re.compile(r"^v\d+\.\d+\.\d+$")
#: The commit status the staging workflow sets after it verifies a publish.
STAGING_CONTEXT = "staging"


class GateClosed(Exception):
    """The tag may not go to production."""


def is_release_tag(tag: str) -> bool:
    """Production accepts only a plain vX.Y.Z tag."""
    return bool(RELEASE.match(tag))


def check_tag(tag: str) -> None:
    if not is_release_tag(tag):
        raise GateClosed(f'"{tag}" is not a release tag. Production takes only a plain version tag like v0.33.0.')


def staging_passed(statuses: list[dict]) -> bool:
    """True when the newest `staging` status (GitHub lists newest first) is a success."""
    for s in statuses:
        if s.get("context") == STAGING_CONTEXT:
            return s.get("state") == "success"
    return False


def check_staging(statuses: list[dict]) -> None:
    if not staging_passed(statuses):
        raise GateClosed("Publish this commit to staging and test it first. It has no passing staging check.")


def check(tag: str | None, statuses: list[dict]) -> None:
    """Both rules. The Release workflow gates the staging commit before the tag exists (tag None)."""
    if tag is not None:
        check_tag(tag)
    check_staging(statuses)


def commit_statuses(repo: str, commit: str, token: str) -> list[dict]:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/commits/{commit}/statuses?per_page=100",
        headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https host)
        return json.loads(resp.read())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tag", default=None, help="the release tag; leave it out to gate a commit before it is tagged")
    parser.add_argument("--commit", required=True, help="the commit the tag points at")
    parser.add_argument("--repo", required=True, help="owner/name on GitHub")
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", "")
    try:
        check(args.tag, commit_statuses(args.repo, args.commit, token))
    except (GateClosed, OSError) as exc:
        print(f"Production gate: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"{args.tag or 'Commit'} ({args.commit}) passed staging and may go to production.")


if __name__ == "__main__":
    main()
