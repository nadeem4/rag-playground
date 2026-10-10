"""Check a pull request title is a Conventional Commit.

    PR_TITLE="feat: the miss trace" python scripts/check_pr_title.py

Pull requests are squash-merged, so the title becomes the commit on main, and
the Release workflow calculates the version from those commits (cliff.toml).
The title must be `type(optional scope)!?: description`, with one of the types
below; `!` marks a breaking change. The title is read from the environment,
never from the command line, so a title cannot run as shell.
"""

from __future__ import annotations

import os
import re
import sys

#: feat, fix and perf make a release; the rest is housekeeping.
TYPES = ("feat", "fix", "perf", "docs", "chore", "test", "ops", "ci", "refactor", "style", "build")
PATTERN = re.compile(r"^(?P<type>[a-z]+)(?P<scope>\([^)]*\))?(?P<bang>!)?: (?P<desc>\S.*)$")
EXAMPLE = 'For example "feat: Why did this miss? on Evaluate" or "fix(evaluate): the score".'


def problem(title: str) -> str | None:
    """None when the title is well formed, else what is wrong, in plain words."""
    head = re.match(r"^([A-Za-z]+)", title)
    if not head or head.group(1) not in TYPES:
        return f"The title must start with a type: {', '.join(TYPES)}. {EXAMPLE}"
    m = PATTERN.match(title)
    if m and m.group("scope") == "()":
        return f"The scope in brackets is empty: write one or leave the brackets out. {EXAMPLE}"
    if not m:
        return f'After the type (and an optional scope or "!"), write ": " and a description. {EXAMPLE}'
    return None


def main() -> None:
    title = os.environ.get("PR_TITLE", "")
    message = problem(title)
    if message:
        print(f'Pull request title "{title}": {message}', file=sys.stderr)
        sys.exit(1)
    print(f'Pull request title is well formed: "{title}"')


if __name__ == "__main__":
    main()
