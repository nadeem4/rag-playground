"""The link preview: the page names an absolute share image, and the image is there at 1200 x 630."""

import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = "https://nadeem4nk-rag-playground.hf.space"


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", head[16:24])


def test_the_page_names_an_absolute_share_image():
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    image = re.search(r'property="og:image" content="([^"]+)"', html)
    assert image and image.group(1) == f"{DEMO}/og-image.png"
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert 'property="og:url" content="https://rag.codewithnk.com"' in html


def test_the_share_image_is_served_and_matches_the_banner():
    og = ROOT / "web" / "public" / "og-image.png"
    banner = ROOT / "assets" / "banner.png"
    assert png_size(og) == (1200, 630)
    assert og.read_bytes() == banner.read_bytes()
