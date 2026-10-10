"""Record the short clips Home shows, from a real session against a local server.

    cd web && npm run build && cd ..
    uv run --with playwright==1.55.0 playwright install chromium                                     # once
    uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py            # all three
    uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py evaluate   # one clip

It starts the server in demo mode (`RAG_PLAYGROUND_DEMO=1`, so the Dev menu
is hidden) on its own port (8231 unless `--port` says otherwise), with a fresh
artifact and source directory in a temp folder, and stops it by its own
process when done. It refuses to start when something already answers on
that port, so it never records against another server. It drives the
Playwright Chromium that `playwright install chromium` puts in
%LOCALAPPDATA%\\ms-playwright on Windows; pin the Playwright package to the
version that matches that browser build (1.55.0 for chromium-1187).

Each clip has a setup pass that is not recorded: it loads the sample, makes
the changes the clip needs and runs every step once, so the recorded pass
reads warm results and fits in 8 to 15 seconds. The recorded pass starts from
the setup's stored state in a fresh browser context, once in the light theme
and once in the dark. Timing is set by the pauses below. Each scene notes the
moment its page has loaded; the recording is cut to start there, so no blank
frame opens the loop, and re-encoded to WebM VP9 with the ffmpeg binary that
the imageio-ffmpeg package ships (`imageio_ffmpeg.get_ffmpeg_exe()`).

Writes `web/public/clips/<name>.webm` and `<name>-dark.webm` (1280x800; Build at
1440x900, with the Ask dock seeded open at 698 px so the slope shows), and a
`.jpg` poster for each, taken with Playwright's screenshot at the clip's
telling moment.

`compare` shows Compare's setup cards, presses Run 3 recipes, lets the rows
fill in and ends on the finding sentence. Its setup runs only Parse and Clean,
and each take starts a fresh server on a copy of the data as setup left it,
so the three chunk recipes really run on camera in both themes while the
shared steps come from the cache.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import Page

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "clips"
SIZE = {"width": 1280, "height": 800}
#: Build is recorded wider, still 16:10, so the docked Ask panel can take 698 px:
#: over the 640 px its comparison needs to set the lists side by side with the slope.
SIZES = {"build": {"width": 1440, "height": 900}}
#: The Ask dock as the Build clip shows it: open on the right at 1440 - 380 - 360 - 2 px.
DOCK_SEED = {"open": True, "side": "right", "width": 698}
DOCK_KEY = "rag-playground:ask-dock:v1"


def size_for(name: str) -> dict[str, int]:
    """The viewport and video size of clip `name`."""
    return SIZES.get(name, SIZE)
FAST_TEXT = "Parse: Fast text"
THEMES = {"light": "", "dark": "-dark"}
#: Past the load, so the first frame kept is a painted one.
LOAD_MARGIN = 0.2


def port_answers(port: int) -> bool:
    """True when something already listens on `port` on this machine."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def start_server(port: int, data: Path) -> subprocess.Popen:
    if port_answers(port):
        raise SystemExit(f"port {port} already answers: stop that server or pick another with --port")
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
        if proc.poll() is not None:
            raise SystemExit(f"the server exited with code {proc.returncode} before it answered")
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
    # The dock wide open on the right; the stored state carries it into the recorded pass.
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [DOCK_KEY, json.dumps(DOCK_SEED)])
    page.reload()
    page.get_by_role("button", name="Build the index").wait_for()
    page.get_by_role("button", name="Build the index").click()
    ask = page.get_by_role("button", name="Ask", exact=True)
    pick_reranker(page, "Cross-encoder")
    ask.click(timeout=600_000)  # waits until the build lets it
    page.get_by_text("Search order against the reranked order").wait_for(timeout=600_000)
    # Back to no reranker, so the recorded pass shows the switch. The settings
    # open from the button above the answer or the invite under it; either will do.
    if not page.get_by_role("button", name=re.compile(r"^Reranker")).is_visible():
        page.get_by_role("button", name="Change settings").first.click()
    pick_reranker(page, "No reranker")
    page.wait_for_timeout(500)


def pick(page: Page, label: str, name: str) -> None:
    """Choose `name` in the picker labelled `label`: open its list, then press the option."""
    page.get_by_role("button", name=re.compile("^" + re.escape(label))).first.click()
    page.get_by_role("listbox").get_by_role("option", name=re.compile("^" + re.escape(name))).click()


def pick_reranker(page: Page, name: str) -> None:
    """Choose `name` in the Ask panel's Rerank picker."""
    pick(page, "Reranker", name)


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
    pick_reranker(page, "Cross-encoder")
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
    page.get_by_role("button", name="Parse settings").click()
    pick(page, "Transform", "Fast text")
    page.get_by_role("button", name="Save as").click()
    page.get_by_label("Pipeline name").fill(FAST_TEXT)
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_timeout(500)
    # The working copy goes back to Docling: the pipeline on Build.
    pick(page, "Pipeline", "Working copy")
    page.wait_for_timeout(300)
    pick(page, "Transform", "Docling")
    page.wait_for_timeout(500)
    page.goto(base + "/evaluate")
    evaluate(page)
    pick(page, "Pipeline", FAST_TEXT)
    evaluate(page)


def evaluate_scene(page: Page, base: str, poster: Path) -> float:
    page.goto(base + "/evaluate")
    page.get_by_role("button", name="Evaluate", exact=True).wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    page.wait_for_timeout(1200)
    evaluate(page)
    page.wait_for_timeout(1800)
    pick(page, "Pipeline", FAST_TEXT)
    page.wait_for_timeout(900)
    evaluate(page)
    page.wait_for_timeout(1800)
    # The poster keeps the score in view; the clip goes on to the first miss.
    page.screenshot(path=poster, type="jpeg", quality=80)
    page.get_by_role("button", name=re.compile(r"^Question \d+, missed")).first.click()
    page.wait_for_timeout(2400)
    return loaded


# ---------------------------------------------------------------- compare --


def compare_setup(page: Page, base: str) -> None:
    """Run only the shared steps, Parse and Clean, so the recipes run on camera."""
    pick_sample(page, base, None)
    page.get_by_role("button", name="Clean settings").click()
    clean = page.locator('[data-node-id^="clean"]')
    clean.get_by_role("button", name="Run", exact=True).click()
    clean.get_by_test_id("run-result").wait_for(timeout=600_000)


def run_recipes(page: Page) -> None:
    """Press Run 3 recipes and wait until every recipe has finished.

    The finding line says "Running three recipes" while they run; the button
    reads Running until the run has closed, then Run 3 recipes again.
    """
    page.get_by_role("button", name="Run 3 recipes").click()
    page.get_by_role("button", name="Stop the run").wait_for(timeout=30_000)
    page.get_by_role("button", name="Run 3 recipes").wait_for(timeout=600_000)
    page.get_by_test_id("compare-finding").wait_for()


def compare_scene(page: Page, base: str, poster: Path) -> float:
    page.goto(base + "/compare")
    page.get_by_role("button", name="Run 3 recipes").wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    # The setup cards first: what each recipe will do.
    page.wait_for_timeout(2500)
    run_recipes(page)
    # Then the rows filled in, under the finding sentence.
    page.wait_for_timeout(2500)
    page.screenshot(path=poster, type="jpeg", quality=80)
    page.wait_for_timeout(3500)
    return loaded


CLIPS = {
    "build": (build_setup, build_scene),
    "compare": (compare_setup, compare_scene),
    "evaluate": (evaluate_setup, evaluate_scene),
}
#: Clips whose takes each start from the data as setup left it, so what the
#: scene runs is not already cached by the take before.
COLD_TAKES = {"compare"}


class Server:
    """The one server this script starts, on `port`, with its data in `data`."""

    def __init__(self, port: int, data: Path):
        self.port = port
        self.start(data)

    def start(self, data: Path) -> None:
        self.data = data
        self.proc = start_server(self.port, data)

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=30)
        # On Windows the venv's python.exe is a launcher; the real server
        # process goes with it a moment later. Wait until the port is free.
        deadline = time.time() + 30
        while port_answers(self.port) and time.time() < deadline:
            time.sleep(0.2)


def record(browser, server: Server, base: str, name: str, videos: Path) -> None:
    setup, scene = CLIPS[name]
    frame = size_for(name)
    ctx = browser.new_context(viewport=frame)
    setup(ctx.new_page(), base)
    state = ctx.storage_state()
    ctx.close()
    snapshot = server.data

    for theme, suffix in THEMES.items():
        if name in COLD_TAKES:
            server.stop()
            take = snapshot.parent / f"{snapshot.name}-{name}-{theme}"
            shutil.copytree(snapshot, take)
            server.start(take)
        ctx = browser.new_context(
            viewport=frame, color_scheme=theme, storage_state=state, record_video_dir=str(videos), record_video_size=frame
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
    if name in COLD_TAKES:
        # Back to the data the later clips build on.
        server.stop()
        server.start(snapshot)


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
    ap.add_argument("clips", nargs="*", metavar="clip", help="build, compare or evaluate; all three when none is named")
    ap.add_argument("--port", type=int, default=8231)
    args = ap.parse_args()
    clips = args.clips or list(CLIPS)
    unknown = sorted(set(clips) - set(CLIPS))
    if unknown:
        ap.error(f"unknown clip: {', '.join(unknown)}")
    if not (ROOT / "web" / "dist" / "index.html").exists():
        raise SystemExit("web/dist is missing: run `npm run build` in web/ first")
    OUT.mkdir(parents=True, exist_ok=True)
    base = f"http://127.0.0.1:{args.port}"
    with tempfile.TemporaryDirectory() as tmp:
        server = Server(args.port, Path(tmp) / "data")
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch()
                for name in clips:
                    record(browser, server, base, name, Path(tmp) / "videos")
                browser.close()
        finally:
            server.stop()


if __name__ == "__main__":
    main()
