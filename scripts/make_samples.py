"""Write every sample under `samples/<name>/<name>.pdf`.

    uv run python scripts/make_samples.py

Each generator lives in `scripts/samplegen/` and is byte stable, so this can be
run any time and only changes a file when a generator changed.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.samplegen import (  # noqa: E402
    chunking_primer,
    scanned_notes,
    table_of_figures,
    two_column_report,
)

GENERATORS = [chunking_primer, scanned_notes, two_column_report, table_of_figures]


def main() -> None:
    for gen in GENERATORS:
        out = ROOT / "samples" / gen.NAME / f"{gen.NAME}.pdf"
        out.parent.mkdir(parents=True, exist_ok=True)
        data = gen.build()
        changed = not out.exists() or out.read_bytes() != data
        out.write_bytes(data)
        print(f"{'wrote' if changed else 'unchanged'} {out.relative_to(ROOT)} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
