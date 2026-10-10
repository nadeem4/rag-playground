"""Publish the committed tree to a Hugging Face Space, with demo mode on.

    uv run --no-sync python scripts/publish_space.py --repo <user>/rag-playground [--dry-run]

Only files committed at HEAD are published (`git archive`), so `sources/`,
`.env` and the private notes in `.superpowers/` can never go up, while the
public pages in `docs/` do, and files no longer at HEAD are removed
from the Space. The Space copy differs from the repo in
two places: the README starts with the header Spaces require, and
.gitattributes gains LFS rules for binaries so the Space's build gets real files. Demo mode is set
as a Space variable, so anyone who duplicates the Space can turn it off.
Log in first with `hf auth login`.
"""

from __future__ import annotations

import argparse
import io
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Demo mode is a Space variable, visible and editable in the Space settings.
#: No persistent storage is requested, so the Space's disk (and the run cache
#: under /data) starts empty on each restart. The privacy page says so
#: (web/src/routes/Privacy.tsx); turning persistent storage on makes that line false.
DEMO_VAR = ("RAG_PLAYGROUND_DEMO", "1")

SPACE_HEADER = """---
title: RAG Playground
emoji: 🧪
colorFrom: gray
colorTo: gray
sdk: docker
app_port: 8000
license: mit
short_description: Try each stage of a RAG pipeline on a sample document
thumbnail: https://huggingface.co/spaces/nadeem4nk/rag-playground/resolve/main/assets/banner.png
---

"""


def space_readme(readme: str) -> str:
    return SPACE_HEADER + readme


#: Binary types the Space must keep in LFS. The Space's Docker build checks files
#: out with its own .gitattributes; without these rules it copies LFS pointers
#: (about 130 bytes) instead of the files, and the Home clips play blank.
SPACE_LFS = ("webm", "mp4", "jpg", "jpeg", "png", "ico", "gif", "webp", "pdf", "woff", "woff2", "ttf", "lance", "zip", "gz")


def space_gitattributes(attrs: str) -> str:
    """The repo's .gitattributes, plus an LFS rule for every binary type."""
    lines = [f"*.{ext} filter=lfs diff=lfs merge=lfs -text" for ext in SPACE_LFS]
    return attrs.rstrip("\n") + "\n\n# Hugging Face Space: binaries live in LFS.\n" + "\n".join(lines) + "\n"


def export_tree(dest: Path) -> list[str]:
    """Write the files committed at HEAD into `dest`, return their paths."""
    tar = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT, check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(dest, filter="data")
        names = [m.name for m in t.getmembers() if m.isfile()]
    for name, change in (("README.md", space_readme), (".gitattributes", space_gitattributes)):
        path = dest / name
        path.write_text(change(path.read_text(encoding="utf-8")), encoding="utf-8", newline="\n")
    return names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True, help="Space id, e.g. user/rag-playground")
    parser.add_argument("--dry-run", action="store_true", help="list what would be published and stop")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        names = export_tree(Path(tmp))
        if args.dry_run:
            print("\n".join(sorted(names)))
            print(f"\n{len(names)} files would be published to spaces/{args.repo}")
            return
        from huggingface_hub import HfApi

        api = HfApi()
        api.create_repo(args.repo, repo_type="space", space_sdk="docker", exist_ok=True)
        api.add_space_variable(args.repo, *DEMO_VAR, description="Demo mode: uploads are private, small and deleted after 24 hours; only a visitor's own API key is used; custom endpoints are off. Set to 0 for a private copy.")
        # Mirror HEAD: a file deleted from the repo is deleted from the Space too.
        # Hugging Face always keeps .gitattributes. Without this, a stale file
        # once broke the Space's build (2026-10-04).
        api.upload_folder(
            repo_id=args.repo,
            repo_type="space",
            folder_path=tmp,
            commit_message="Publish from GitHub HEAD",
            delete_patterns=["*"],
        )
        print(f"Published: https://huggingface.co/spaces/{args.repo}")


if __name__ == "__main__":
    main()
