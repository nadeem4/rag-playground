"""Check that every relative link and #anchor in the repo's Markdown files resolves.

    uv run python scripts/check_doc_links.py [--root PATH]

Links to this repo's own files on github.com (blob/main or tree/main) are
mapped to local paths, so package READMEs can keep absolute URLs for PyPI.
Other web links are not fetched. Links inside code fences and inline code are
ignored. Prints `file:line: target: reason` for each broken link and exits 1.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote

REPO_URL = re.compile(r"^https://github\.com/nadeem4/rag-playground/(?:blob|tree)/main/?(.*)$")
MD_LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
REF_DEF = re.compile(r"^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*<?(\S+?)>?(?:\s|$)", re.MULTILINE)
HTML_LINK = re.compile(r"""(?:href|src)=["']([^"']+)["']""")
INLINE_CODE = re.compile(r"`[^`]*`")
HEADING = re.compile(r"^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$")
SKIP_SCHEMES = ("http://", "https://", "mailto:", "tel:", "data:")


class Problem(NamedTuple):
    file: str
    line: int
    target: str
    reason: str

    def __str__(self) -> str:
        return f"{self.file}:{self.line}: {self.target}: {self.reason}"


def slugify(heading: str) -> str:
    """GitHub's anchor rule: lowercase, drop punctuation, spaces become hyphens."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"[`*~]", "", text).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def _content_lines(text: str):
    """Yield (line number, line) outside code fences."""
    fence = None
    for number, line in enumerate(text.splitlines(), start=1):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            if fence is None:
                fence = marker.group(1)[0]
            elif marker.group(1)[0] == fence:
                fence = None
            continue
        if fence is None:
            yield number, line


def anchors(path: Path) -> set[str]:
    seen: dict[str, int] = {}
    found: set[str] = set()
    for _, line in _content_lines(path.read_text(encoding="utf-8")):
        match = HEADING.match(line)
        if not match:
            continue
        slug = slugify(match.group(1))
        count = seen.get(slug, 0)
        seen[slug] = count + 1
        found.add(slug if count == 0 else f"{slug}-{count}")
    return found


def markdown_files(root: Path) -> list[Path]:
    if (root / ".git").exists():
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "*.md"], capture_output=True, check=True
        ).stdout.decode("utf-8")
        return [root / name for name in out.split("\0") if name and (root / name).is_file()]
    return sorted(root.rglob("*.md"))


def _targets(text: str):
    """Yield (line number, target) from text whose code fences are blanked out."""
    text = INLINE_CODE.sub(lambda m: re.sub(r"[^\n]", " ", m.group()), text)
    for pattern in (MD_LINK, REF_DEF, HTML_LINK):
        for match in pattern.finditer(text):
            yield text.count("\n", 0, match.start(1)) + 1, match.group(1)


def check(root: Path) -> list[Problem]:
    root = Path(root)
    cache: dict[Path, set[str]] = {}
    problems: list[Problem] = []

    def anchors_of(path: Path) -> set[str]:
        if path not in cache:
            cache[path] = anchors(path) if path.suffix == ".md" else set()
        return cache[path]

    for md in markdown_files(root):
        rel = md.relative_to(root).as_posix()
        text = md.read_text(encoding="utf-8")
        kept = dict(_content_lines(text))
        body = "\n".join(kept.get(n, "") for n in range(1, len(text.splitlines()) + 1))
        for number, target in _targets(body):
            reason = _problem(root, md, target, anchors_of)
            if reason:
                problems.append(Problem(rel, number, target, reason))
    return problems


def _problem(root: Path, md: Path, target: str, anchors_of) -> str | None:
    mapped = REPO_URL.match(target)
    if mapped:
        target = mapped.group(1) or "."
        base = root
    elif target.startswith(SKIP_SCHEMES):
        return None
    else:
        base = md.parent
    path_part, _, anchor = target.partition("#")
    if path_part:
        resolved = (base / unquote(path_part)).resolve()
        if not resolved.exists():
            return "file not found"
    else:
        resolved = md
    if anchor and resolved.is_file() and resolved.suffix == ".md":
        if unquote(anchor) not in anchors_of(resolved):
            return "anchor not found"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")
    problems = check(args.root)
    for problem in problems:
        print(problem)
    if problems:
        print(f"{len(problems)} broken link(s).")
        return 1
    print("All doc links resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
