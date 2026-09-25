"""Publish the committed tree to a Hugging Face Space, with demo mode on.

    uv run --no-sync python scripts/publish_space.py --repo <user>/rag-playground [--dry-run]

Only files committed at HEAD are published (`git archive`), so `sources/`,
`.env` and `docs/` can never go up. The Space copy differs from the repo in
one place: the README starts with the header Spaces require. Demo mode is set
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


def export_tree(dest: Path) -> list[str]:
    """Write the files committed at HEAD into `dest`, return their paths."""
    tar = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT, check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(dest, filter="data")
        names = [m.name for m in t.getmembers() if m.isfile()]
    for name, change in (("README.md", space_readme),):
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
        api.add_space_variable(args.repo, *DEMO_VAR, description="Demo mode: no uploads, sample document only, visitor's API key only.")
        api.upload_folder(repo_id=args.repo, repo_type="space", folder_path=tmp, commit_message="Publish from GitHub HEAD")
        print(f"Published: https://huggingface.co/spaces/{args.repo}")


if __name__ == "__main__":
    main()
