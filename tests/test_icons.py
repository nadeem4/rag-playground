"""The app's icon: one source mark (favicon.svg) and the files browsers and phones ask for."""

import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "web" / "public"
ACCENT = "#0f6e51"  # --accent in tokens.css, oklch(0.48 0.095 166)


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", head[16:24])


def test_the_mark_is_the_chunked_page_on_the_app_accent():
    svg = (PUBLIC / "favicon.svg").read_text(encoding="utf-8")
    assert ACCENT in svg
    # Three chunk bands in the chunk view's own colours.
    for colour in ("#e68d9c", "#5cb6e6", "#e19766"):
        assert colour in svg


def test_the_png_icons_have_the_sizes_phones_and_manifests_use():
    assert png_size(PUBLIC / "apple-touch-icon.png") == (180, 180)
    assert png_size(PUBLIC / "icon-192.png") == (192, 192)
    assert png_size(PUBLIC / "icon-512.png") == (512, 512)


def test_favicon_ico_holds_16_and_32():
    data = (PUBLIC / "favicon.ico").read_bytes()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    assert (reserved, kind) == (0, 1)
    sizes = {data[6 + 16 * i] or 256 for i in range(count)}
    assert {16, 32} <= sizes


def test_the_manifest_names_the_app_and_its_icons():
    manifest = json.loads((PUBLIC / "site.webmanifest").read_text(encoding="utf-8"))
    assert manifest["name"] == "RAG Playground"
    assert {i["src"] for i in manifest["icons"]} == {"/icon-192.png", "/icon-512.png"}
    assert manifest["theme_color"] == ACCENT


def test_the_page_links_every_icon():
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    for tag in (
        '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
        '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
        '<link rel="manifest" href="/site.webmanifest" />',
    ):
        assert tag in html, tag
