"""Render the app's icons from web/public/favicon.svg.

    uv run --with playwright==1.55.0 --with pillow python scripts/render_icons.py

Writes apple-touch-icon.png (180), icon-192.png, icon-512.png and favicon.ico
(16 and 32) next to the SVG. The phone icons are full-bleed squares, because
iOS and Android round the corners themselves.
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parents[1] / "web" / "public"
SVG = PUBLIC / "favicon.svg"
ACCENT = "#0f6e51"


def render(page, svg: str, size: int, full_bleed: bool) -> Image.Image:
    # Full bleed: an accent square behind the mark, so the platform's own rounding shows no corners.
    back = f"background:{ACCENT};" if full_bleed else "background:transparent;"
    page.set_viewport_size({"width": size, "height": size})
    page.set_content(f'<html><body style="margin:0;{back}"><div style="width:{size}px;height:{size}px">{svg}</div></body></html>')
    page.evaluate("document.querySelector('svg').setAttribute('width','100%'); document.querySelector('svg').setAttribute('height','100%')")
    shot = page.screenshot(omit_background=not full_bleed, clip={"x": 0, "y": 0, "width": size, "height": size})
    return Image.open(io.BytesIO(shot)).convert("RGBA")


def main() -> None:
    svg = SVG.read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        render(page, svg, 180, True).save(PUBLIC / "apple-touch-icon.png")
        render(page, svg, 192, True).save(PUBLIC / "icon-192.png")
        render(page, svg, 512, True).save(PUBLIC / "icon-512.png")
        big = render(page, svg, 64, False)
        big.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32)])
        browser.close()
    print("wrote the icons in", PUBLIC)


if __name__ == "__main__":
    main()
