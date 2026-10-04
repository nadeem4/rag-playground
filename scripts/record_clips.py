"""Record the short clips Home shows, from a real session against a local server.

    cd web && npm run build && cd ..
    uv run --with playwright==1.55.0 python scripts/record_clips.py            # build and evaluate
    uv run --with playwright==1.55.0 python scripts/record_clips.py evaluate   # one clip

It starts the server on its own port (8231 unless `--port` says otherwise),
with a fresh artifact and source directory in a temp folder, and stops it by
its own process when done. It drives the installed Playwright Chromium (in
%LOCALAPPDATA%\\ms-playwright on Windows); pin the Playwright package to the
version that matches that browser build (1.55.0 for chromium-1187).

Each clip has a setup pass that is not recorded: it loads the sample, makes
the changes the clip needs and runs every step once, so the recorded pass
reads warm results and fits in 8 to 15 seconds. The recorded pass starts from
the setup's stored state in a fresh browser context. Timing is set by the
pauses below, not by an editor; nothing is trimmed afterwards.

Writes `web/public/clips/<name>.webm` (1280x800) and `<name>.jpg`, a poster
taken with Playwright's screenshot at the clip's telling moment. ffmpeg is not
needed beyond the one Playwright ships for recording.

Compare has no clip yet: `compare` saves only a poster of the Compare page.
"""

from __future__ import annotations

import argparse
import os
import shutil
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


def start_server(port: int, data: Path) -> subprocess.Popen:
    env = {
        **os.environ,
        "RAG_PLAYGROUND_ARTIFACTS": str(data / "artifacts"),
        "RAG_PLAYGROUND_SOURCES": str(data / "sources"),
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


def build_scene(page: Page, base: str) -> None:
    page.goto(base + "/build")
    build = page.get_by_role("button", name="Build the index")
    build.wait_for()
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
    page.screenshot(path=OUT / "build.jpg", type="jpeg", quality=80)
    page.wait_for_timeout(2200)


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


def evaluate_scene(page: Page, base: str) -> None:
    page.goto(base + "/evaluate")
    page.get_by_role("button", name="Evaluate", exact=True).wait_for()
    page.wait_for_timeout(1200)
    evaluate(page)
    page.wait_for_timeout(1800)
    page.get_by_role("combobox", name="Pipeline", exact=True).select_option(label=FAST_TEXT)
    page.wait_for_timeout(900)
    evaluate(page)
    page.wait_for_timeout(1800)
    page.get_by_role("button", name="missed", exact=False).first.click()
    page.wait_for_timeout(1800)
    page.screenshot(path=OUT / "evaluate.jpg", type="jpeg", quality=80)
    page.wait_for_timeout(1500)


# ---------------------------------------------------------------- compare --


def compare_poster(browser, base: str) -> None:
    """Compare has no clip yet: a still of the page with the sample loaded."""
    ctx = browser.new_context(viewport=SIZE)
    page = ctx.new_page()
    pick_sample(page, base, None)
    page.goto(base + "/compare")
    page.wait_for_timeout(2500)
    page.screenshot(path=OUT / "compare.jpg", type="jpeg", quality=80)
    ctx.close()
    print(f"compare.jpg {(OUT / 'compare.jpg').stat().st_size // 1024} KB")


CLIPS = {"build": (build_setup, build_scene), "evaluate": (evaluate_setup, evaluate_scene)}


def record(browser, base: str, name: str, videos: Path) -> None:
    setup, scene = CLIPS[name]
    ctx = browser.new_context(viewport=SIZE)
    setup(ctx.new_page(), base)
    state = ctx.storage_state()
    ctx.close()

    ctx = browser.new_context(viewport=SIZE, storage_state=state, record_video_dir=str(videos), record_video_size=SIZE)
    page = ctx.new_page()
    started = time.time()
    scene(page, base)
    seconds = time.time() - started
    video = Path(page.video.path())
    ctx.close()
    target = OUT / f"{name}.webm"
    shutil.copyfile(video, target)
    size = target.stat().st_size
    print(f"{name}.webm {seconds:.1f} s, {size / 1048576:.2f} MB")
    if not 8 <= seconds <= 15:
        print(f"  warning: {name} runs {seconds:.1f} s, outside 8 to 15 s")


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
