"""Record the short clips Home shows, from a real session against a local server.

    cd web && npm run build && cd ..
    uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py            # build and evaluate
    uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py evaluate   # one clip

It starts the server in demo mode (`RAG_PLAYGROUND_DEMO=1`, so the Dev menu
is hidden) on its own port (8231 unless `--port` says otherwise), with a fresh
artifact and source directory in a temp folder, and stops it by its own
process when done. It drives the installed Playwright Chromium (in
%LOCALAPPDATA%\\ms-playwright on Windows); pin the Playwright package to the
version that matches that browser build (1.55.0 for chromium-1187).

Each clip has a setup pass that is not recorded: it loads the sample, makes
the changes the clip needs and runs every step once, so the recorded pass
reads warm results and fits in 8 to 15 seconds. The recorded pass starts from
the setup's stored state in a fresh browser context, once in the light theme
and once in the dark. Timing is set by the pauses below. Each scene notes the
moment its page has loaded; the recording is cut to start there, so no blank
frame opens the loop, and re-encoded to WebM VP9 with the ffmpeg binary that
the imageio-ffmpeg package ships (`imageio_ffmpeg.get_ffmpeg_exe()`).

Writes `web/public/clips/<name>.webm` and `<name>-dark.webm` (1280x800), and a
`.jpg` poster for each, taken with Playwright's screenshot at the clip's
telling moment.

Compare has no clip yet: `compare` saves only a poster of the Compare page, in
both themes.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "clips"
SIZE = {"width": 1280, "height": 800}
FAST_TEXT = "Parse: Fast text"
THEMES = {"light": "", "dark": "-dark"}
#: Past the load, so the first frame kept is a painted one.
LOAD_MARGIN = 0.2


def start_server(port: int, data: Path) -> subprocess.Popen:
    env = {
        **os.environ,
        "RAG_PLAYGROUND_ARTIFACTS": str(data / "artifacts"),
        "RAG_PLAYGROUND_SOURCES": str(data / "sources"),
        # As on the hosted demo: no Dev menu in the header.
        "RAG_PLAYGROUND_DEMO": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/registry", timeout=2)
            return proc
        except OSError:
            time.sleep(0.5)
    proc.terminate()
    raise SystemExit("the server did not start")


def pick_sample(page: Page, base: str, title: str | None) -> None:
    """Load the first sample the way a visitor does, from Home, then switch to `title` if given."""
    page.goto(base + "/")
    page.get_by_role("button", name="Try it yourself on Build").click()
    page.wait_for_url("**/build")
    page.get_by_role("button", name="Build the index").wait_for()
    if title:
        page.get_by_role("button", name="Document:", exact=False).click()
        page.get_by_text(title, exact=True).click()
        page.wait_for_timeout(1500)


def evaluate(page: Page) -> None:
    """Press Evaluate and wait until the scores are in."""
    page.get_by_role("button", name="Evaluate", exact=False).last.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="Evaluate again").wait_for(timeout=600_000)


# ------------------------------------------------------------------ build --


def build_setup(page: Page, base: str) -> None:
    pick_sample(page, base, None)
    page.get_by_role("button", name="Build the index").click()
    ask = page.get_by_role("button", name="Ask", exact=True)
    page.get_by_role("button", name="Cross-encoder").click()
    ask.click(timeout=600_000)  # waits until the build lets it
    page.get_by_text("Search order against the reranked order").wait_for(timeout=600_000)
    # Back to no reranker, so the recorded pass shows the switch.
    page.get_by_role("button", name="Change settings").click()
    page.get_by_role("button", name="None", exact=True).nth(1).click()
    page.wait_for_timeout(500)


def build_scene(page: Page, base: str, poster: Path) -> float:
    page.goto(base + "/build")
    build = page.get_by_role("button", name="Build the index")
    build.wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    page.wait_for_timeout(1200)
    build.click()
    page.get_by_text("Index ready", exact=False).wait_for(timeout=60_000)
    page.wait_for_timeout(1400)
    page.get_by_role("button", name="Cross-encoder").click()
    page.wait_for_timeout(900)
    page.get_by_role("button", name="Ask", exact=True).click()
    slope = page.get_by_text("Search order against the reranked order")
    slope.wait_for(timeout=60_000)
    page.wait_for_timeout(600)
    slope.evaluate("el => el.scrollIntoView({ behavior: 'smooth', block: 'start' })")
    page.wait_for_timeout(2200)
    page.screenshot(path=poster, type="jpeg", quality=80)
    page.wait_for_timeout(2800)
    return loaded


# --------------------------------------------------------------- evaluate --


def evaluate_setup(page: Page, base: str) -> None:
    pick_sample(page, base, "Two-column report")
    page.get_by_role("button", name="Expand Parse").click()
    parser = page.locator("select").filter(has_text="Fast text, pdfium")
    parser.select_option(label="Fast text, pdfium")
    page.get_by_role("button", name="Save as").click()
    page.get_by_label("Pipeline name").fill(FAST_TEXT)
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_timeout(500)
    # The working copy goes back to Docling: the pipeline on Build.
    page.get_by_role("combobox", name="Pipeline", exact=True).select_option(label="Working copy")
    page.wait_for_timeout(300)
    parser.select_option(label="Docling, docling")
    page.wait_for_timeout(500)
    page.goto(base + "/evaluate")
    evaluate(page)
    page.get_by_role("combobox", name="Pipeline", exact=True).select_option(label=FAST_TEXT)
    evaluate(page)


def evaluate_scene(page: Page, base: str, poster: Path) -> float:
    page.goto(base + "/evaluate")
    page.get_by_role("button", name="Evaluate", exact=True).wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    page.wait_for_timeout(1200)
    evaluate(page)
    page.wait_for_timeout(1800)
    page.get_by_role("combobox", name="Pipeline", exact=True).select_option(label=FAST_TEXT)
    page.wait_for_timeout(900)
    evaluate(page)
    page.wait_for_timeout(1800)
    page.get_by_role("button", name="missed", exact=False).first.click()
    page.wait_for_timeout(1800)
    page.screenshot(path=poster, type="jpeg", quality=80)
    page.wait_for_timeout(1800)
    return loaded


# ---------------------------------------------------------------- compare --


def compare_poster(browser, base: str) -> None:
    """Compare has no clip yet: a still of the page with the sample loaded, in each theme."""
    for theme, suffix in THEMES.items():
        ctx = browser.new_context(viewport=SIZE, color_scheme=theme)
        page = ctx.new_page()
        pick_sample(page, base, None)
        page.goto(base + "/compare")
        page.wait_for_timeout(2500)
        poster = OUT / f"compare{suffix}.jpg"
        page.screenshot(path=poster, type="jpeg", quality=80)
        ctx.close()
        print(f"{poster.name} {poster.stat().st_size // 1024} KB")


CLIPS = {"build": (build_setup, build_scene), "evaluate": (evaluate_setup, evaluate_scene)}


def record(browser, base: str, name: str, videos: Path) -> None:
    setup, scene = CLIPS[name]
    ctx = browser.new_context(viewport=SIZE)
    setup(ctx.new_page(), base)
    state = ctx.storage_state()
    ctx.close()

    for theme, suffix in THEMES.items():
        ctx = browser.new_context(
            viewport=SIZE, color_scheme=theme, storage_state=state, record_video_dir=str(videos), record_video_size=SIZE
        )
        # The recording starts with the page.
        started = time.time()
        page = ctx.new_page()
        loaded = scene(page, base, OUT / f"{name}{suffix}.jpg") - started + LOAD_MARGIN
        seconds = time.time() - started - loaded
        raw = Path(page.video.path())
        ctx.close()
        target = OUT / f"{name}{suffix}.webm"
        encode(raw, target, loaded)
        size = target.stat().st_size
        print(f"{target.name} {seconds:.1f} s from the loaded page at {loaded:.1f} s, {size / 1048576:.2f} MB")
        if not 8 <= seconds <= 15:
            print(f"  warning: {target.name} runs {seconds:.1f} s, outside 8 to 15 s")
        if size > 1.5 * 1048576:
            print(f"  warning: {target.name} is over 1.5 MB")


def encode(raw: Path, target: Path, start: float) -> None:
    """Cut `raw` to start at `start` seconds and re-encode it to WebM VP9, with no audio."""
    from imageio_ffmpeg import get_ffmpeg_exe

    subprocess.run(
        [
            get_ffmpeg_exe(), "-y", "-loglevel", "error",
            "-i", str(raw), "-ss", f"{start:.2f}",
            "-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
            "-an", str(target),
        ],
        check=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("clips", nargs="*", default=["build", "evaluate"], choices=[*CLIPS, "compare"])
    ap.add_argument("--port", type=int, default=8231)
    args = ap.parse_args()
    if not (ROOT / "web" / "dist" / "index.html").exists():
        raise SystemExit("web/dist is missing: run `npm run build` in web/ first")
    OUT.mkdir(parents=True, exist_ok=True)
    base = f"http://127.0.0.1:{args.port}"
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp)
        server = start_server(args.port, data)
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                for name in args.clips:
                    if name == "compare":
                        compare_poster(browser, base)
                    else:
                        record(browser, base, name, data / "videos")
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=30)


if __name__ == "__main__":
    main()
