"""Render assets/banner.html to the share image.

    uv run --with playwright==1.55.0 python scripts/render_banner.py

Writes assets/banner.png (1200 x 630, the Space thumbnail and the README) and
web/public/og-image.png (the same image, served by the app for link previews).
With --scale 2 it also writes a 2400 x 1260 copy for uploading to LinkedIn, to
the path given by --linkedin.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "assets" / "banner.html"
PNG = ROOT / "assets" / "banner.png"
OG = ROOT / "web" / "public" / "og-image.png"


def shoot(page_scale: int, out: Path) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=page_scale)
        page.goto(HTML.as_uri())
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(400)
        page.locator(".banner").screenshot(path=str(out))
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--linkedin", type=Path, help="also write a 2x copy here")
    args = parser.parse_args()
    shoot(1, PNG)
    shutil.copyfile(PNG, OG)
    print("wrote", PNG, "and", OG)
    if args.linkedin:
        shoot(2, args.linkedin)
        print("wrote", args.linkedin)


if __name__ == "__main__":
    main()
