"""Record the short clips Home shows, from a real session against a local server.

    cd playground/frontend && npm run build && cd ../..
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
reads warm results and fits in 20 to 35 seconds (one clip per page, with
chapter chips under it on Home). The recorded pass starts from the setup's
stored state in a fresh browser context, once in the light theme and once in
the dark. Timing is set by the pauses below. Each scene notes the
moment its page has loaded; the recording is cut to start there, so no blank
frame opens the loop, and re-encoded to WebM VP9 with the ffmpeg binary that
the imageio-ffmpeg package ships (`imageio_ffmpeg.get_ffmpeg_exe()`).

Writes `playground/frontend/public/clips/<name>.webm` and `<name>-dark.webm` (1280x800; Build at
1440x900, with the Ask dock seeded open at 698 px so the answer sits beside the steps), and a
`.jpg` poster for each, taken with Playwright's screenshot at the clip's
telling moment. Each is kept under about 4 MB.

Chapters: a scene calls `mark()` where each chapter of the clip starts. After
the encode, the marks become seconds from the cut start (the first is 0) and
go to `playground/frontend/src/routes/clipChapters.json` as
`{"build": {"light": [0, 5.1, ...], "dark": [...]}, ...}`. The file is read and
merged, so recording one clip keeps the others' entries; a scene that marks
nothing leaves its entry as it was.

`build` is five chapters: pick a template, add a second document, build the
index, ask with Search then Chat, ask something the documents do not answer.
Chat needs a key, and the server runs in demo mode, which ignores its own
key, so the recorder sends `ANTHROPIC_API_KEY` (from the environment or the
repo's `.env`, never printed or stored) as the request header on every API
call, and answers the key-status request as a server holding the key would.
The setup pass runs the whole scene once, without its pauses, in a second
browser context, warming the step cache and the Chat answers so the recorded
pass reads them cached.

`evaluate` is five chapters: Write questions for me, run and score, change the
Parse setting (Fast text), Compare the two (this run against the best), open a
missed question's trace. The model writes the questions in the setup's warm
pass; each recorded take reads that same run (the recorder answers the
`questions/generate` request with its run id), so it shows the review, a drop
and Save without a second model call. Steps and scores come from the cache.
It sends the key like `build`.

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
OUT = ROOT / "playground" / "frontend" / "public" / "clips"
CHAPTERS_FILE = ROOT / "playground" / "frontend" / "src" / "routes" / "clipChapters.json"
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


#: Chapter starts of the take being recorded, as `time.time()`; `mark()` adds one.
MARKS: list[float] = []
#: True during a clip's setup warm pass: the scene runs without its pauses and without a poster.
WARM = False
#: Clips whose scenes call the model, so their browser sends a key.
KEYED = {"build", "evaluate"}


def mark() -> None:
    """A scene calls this where a chapter of the clip starts."""
    MARKS.append(time.time())


def pause(page: Page, ms: int) -> None:
    """A pause the viewer reads in; the warm pass skips it."""
    if not WARM:
        page.wait_for_timeout(ms)


def anthropic_key() -> str:
    """The key for Chat: the environment's, else the repo's `.env`. Never printed."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        from dotenv import dotenv_values

        key = dotenv_values(ROOT / ".env").get("ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit("the build clip needs ANTHROPIC_API_KEY, in the environment or in .env")
    return key.strip()


def install_key(ctx) -> None:
    """Send the key with every API call from `ctx`, as the header the UI's key panel would send.

    The demo server ignores its own keys, so it would report none and turn Chat
    off; the key-status answer is the one a server holding the key would give.
    """
    key = anthropic_key()

    def handle(route) -> None:
        req = route.request
        if req.method == "GET" and req.url.split("?")[0].endswith("/settings/models"):
            route.fulfill(json={"anthropic": "env", "openai": "none", "custom": "none", "openrouter": "none"})
        else:
            route.continue_(headers={**req.headers, "x-anthropic-api-key": key})

    ctx.route("**/api/**", handle)


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
        [sys.executable, "-m", "uvicorn", "playground.backend.main:app", "--host", "127.0.0.1", "--port", str(port)],
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
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v2/health", timeout=2)
            return proc
        except OSError:
            time.sleep(0.5)
    proc.terminate()
    raise SystemExit("the server did not start")


def pick_sample(page: Page, base: str, title: str | None) -> None:
    """Load the first sample the way a visitor does, from Home, then switch to `title` if given."""
    page.goto(base + "/")
    page.get_by_role("button", name="Try a sample").click()
    page.wait_for_url("**/build*")
    page.get_by_role("button", name="Build the index").wait_for()
    if title:
        # Build's Document card only adds; Evaluate's Documents line has Change.
        page.goto(base + "/evaluate")
        page.get_by_role("button", name="Change the document", exact=False).click()
        page.get_by_text(title, exact=True).click()
        page.wait_for_timeout(1500)
        page.goto(base + "/build")
        page.get_by_role("button", name="Build the index").wait_for()


def evaluate(page: Page) -> None:
    """Press Evaluate and wait until the scores are in."""
    page.get_by_role("button", name="Evaluate", exact=False).last.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="Evaluate again").wait_for(timeout=600_000)


# ------------------------------------------------------------------ build --


#: What the fourth chapter asks, and what the fifth adds that the documents do not answer.
ASK_Q = "What do the dashes on the display mean?"
ASK_MORE = ", and which vector database is the fastest?"


def build_setup(page: Page, base: str) -> None:
    """Leave `page`'s context clean (one sample, the dock open), after a warm pass in another one."""
    global WARM
    pick_sample(page, base, None)
    # The dock wide open on the right; the stored state carries it into the recorded pass.
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [DOCK_KEY, json.dumps(DOCK_SEED)])
    page.reload()
    page.get_by_role("button", name="Build the index").wait_for()
    # The whole scene once, with no pauses, in a context of its own: the server keeps
    # every step result and Chat answer, and this context keeps nothing of it.
    warm = page.context.browser.new_context(viewport=size_for("build"), storage_state=page.context.storage_state())
    install_key(warm)
    WARM = True
    try:
        build_scene(warm.new_page(), base, None)
    finally:
        WARM = False
        MARKS.clear()
        warm.close()


def pick(page: Page, label: str, name: str) -> None:
    """Choose `name` in the picker labelled `label`: open its list, then press the option."""
    page.get_by_role("button", name=re.compile("^" + re.escape(label))).first.click()
    page.get_by_role("listbox").get_by_role("option", name=re.compile("^" + re.escape(name))).click()


def pick_reranker(page: Page, name: str) -> None:
    """Choose `name` in the Ask panel's Rerank picker."""
    pick(page, "Reranker", name)


def ask_done(page: Page) -> None:
    """Wait until the question is answered: the Ask button is back."""
    page.wait_for_timeout(800)
    page.get_by_role("button", name="Ask", exact=True).wait_for(timeout=600_000)
    page.wait_for_timeout(300)


def smooth_to(loc, block: str = "start") -> None:
    loc.evaluate(f"el => el.scrollIntoView({{ behavior: 'smooth', block: '{block}' }})")


def build_scene(page: Page, base: str, poster: Path | None) -> float:
    page.goto(base + "/build")
    build = page.get_by_role("button", name="Build the index")
    build.wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    pause(page, 800)

    # 1. Start from a template: a document template and a question template.
    mark()
    page.get_by_role("button", name="Start from a template").click()
    pause(page, 1200)
    page.get_by_role("button", name=re.compile("^Manuals and guides")).click()
    pause(page, 800)
    page.get_by_role("button", name=re.compile("^Balanced")).click()
    pause(page, 1200)
    page.get_by_role("button", name="Use this pipeline").click()
    pause(page, 1500)

    # 2. Add several documents: a second sample joins the first.
    mark()
    page.get_by_role("button", name=re.compile("^Add a document")).click()
    pause(page, 1200)
    page.get_by_label(re.compile("^Add a document")).get_by_text("A weather station manual").click()
    pause(page, 2500)

    # 3. Watch every step: the build, then the step cards, for each document.
    mark()
    build.click()
    smooth_to(page.locator('[data-node-id^="parse"]'))
    page.get_by_text("Index ready", exact=False).wait_for(timeout=900_000)
    pause(page, 1200)
    smooth_to(page.locator('[data-node-id^="chunk"]'))
    pause(page, 1200)
    page.get_by_label("Showing the steps for").select_option(label="station-manual.pdf")
    pause(page, 1500)

    # 4. Ask: Search, then Chat.
    mark()
    box = page.get_by_role("textbox").first
    box.fill("")
    box.press_sequentially(ASK_Q, delay=25)
    pause(page, 500)
    ask = page.get_by_role("button", name="Ask", exact=True)
    ask.click()
    ask_done(page)
    pause(page, 2000)
    mode = page.get_by_role("group", name="Answer with")
    smooth_to(mode, "center")
    pause(page, 1000)
    mode.get_by_role("button", name="Chat with a model").click()
    pause(page, 700)
    ask.click()
    ask_done(page)
    pause(page, 2200)

    # 5. Answers say what is missing: more is asked than the documents hold.
    mark()
    smooth_to(box, "center")
    pause(page, 800)
    box.click()
    box.press("End")
    box.press("Backspace")
    box.press_sequentially(ASK_MORE, delay=25)
    pause(page, 500)
    ask.click()
    ask_done(page)
    if page.locator("[data-testid=ask-answer] [data-not-found]").count() == 0:
        raise SystemExit("the Chat answer has no Not in the documents part: change ASK_MORE")
    pause(page, 1500)
    if poster:
        page.screenshot(path=poster, type="jpeg", quality=80)
    pause(page, 2200)
    return loaded


# --------------------------------------------------------------- evaluate --


#: How many questions the Evaluate clip asks the model to write.
WRITE_COUNT = 8
#: The run id of the questions the warm pass wrote: the recorded pass reads that
#: run again instead of paying for a second model call.
WRITTEN_RUN: list[str] = []


def evaluate_setup(page: Page, base: str) -> None:
    """Make the Fast text pipeline, then run the whole scene once, without pauses, in another context."""
    global WARM
    pick_sample(page, base, "Two-column report")
    page.get_by_role("button", name="Parse settings").click()
    pick(page, "Transform", "Fast text")
    page.get_by_role("button", name="Save as new").click()
    page.get_by_label("Pipeline name").fill(FAST_TEXT)
    page.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_timeout(500)
    # A new, unsaved pipeline on the same document goes back to Docling: the pipeline on Build.
    pick(page, "Pipeline", "New pipeline")
    page.wait_for_timeout(300)
    pick(page, "Transform", "Docling")
    page.wait_for_timeout(500)
    # The server keeps the written questions and every step result; this context keeps no best run.
    warm = page.context.browser.new_context(viewport=size_for("evaluate"), storage_state=page.context.storage_state())
    install_key(warm)
    WARM = True
    try:
        evaluate_scene(warm.new_page(), base, None)
    finally:
        WARM = False
        MARKS.clear()
        warm.close()


def evaluate_scene(page: Page, base: str, poster: Path | None) -> float:
    if not WARM and WRITTEN_RUN:
        # The model's questions are the warm pass's: this take reads the same run.
        page.route("**/questions/generate", lambda route: route.fulfill(json={"run_id": WRITTEN_RUN[0]}))
    elif WARM:

        def remember(response) -> None:
            if response.url.endswith("/questions/generate") and response.ok:
                WRITTEN_RUN[:] = [response.json()["run_id"]]

        page.on("response", remember)
    page.goto(base + "/evaluate")
    page.get_by_role("button", name="Evaluate", exact=True).wait_for()
    page.wait_for_load_state("networkidle")
    loaded = time.time()
    pause(page, 800)

    # 1. Write questions for me: the model writes, the visitor drops one and keeps the rest.
    mark()
    page.get_by_text("Use your own questions", exact=True).click()
    pause(page, 900)
    page.get_by_role("button", name="Write questions for me").click()
    pause(page, 1200)
    page.get_by_role("spinbutton", name="Questions").fill(str(WRITE_COUNT))
    page.get_by_role("button", name=re.compile(r"^Write \d+ questions?")).click()
    review = page.get_by_test_id("review-summary")
    review.wait_for(timeout=600_000)
    pause(page, 1800)
    page.get_by_test_id("review-list").first.get_by_role("button", name="Drop").nth(1).click()
    pause(page, 1500)
    page.get_by_role("button", name=re.compile(r"^Save \d+ questions?")).click()
    page.get_by_role("button", name="Evaluate", exact=True).wait_for()
    pause(page, 1000)

    # 2. Run and score: found N of M, and the first run is the best so far.
    mark()
    evaluate(page)
    pause(page, 2800)

    # 3. Change one setting: Fast text instead of Docling for Parse, then run again.
    mark()
    pick(page, "Pipeline", FAST_TEXT)
    pause(page, 1200)
    evaluate(page)
    pause(page, 1500)

    # 4. Compare with your best, in place: which questions moved and which way.
    mark()
    compare = page.get_by_role("button", name="Compare the two")
    smooth_to(compare, "center")
    pause(page, 800)
    compare.click()
    page.get_by_text("This run", exact=True).first.wait_for(timeout=600_000)
    pause(page, 1000)
    if poster:
        page.screenshot(path=poster, type="jpeg", quality=80)
    pause(page, 2800)

    # 5. Open a miss: the trace shows the step where the right piece was lost.
    mark()
    # The badge scrolls to the question; its Why did this miss? link opens the trace.
    page.get_by_role("button", name=re.compile(r"^Question \d+, missed")).first.click()
    pause(page, 1200)
    page.get_by_role("button", name="Why did this miss?").first.click()
    page.get_by_test_id("detail-trace").wait_for()
    pause(page, 4200)
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
    if name in KEYED:
        install_key(ctx)
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
        if name in KEYED:
            install_key(ctx)
        # The recording starts with the page.
        MARKS.clear()
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
        if not 20 <= seconds <= 35:
            print(f"  warning: {target.name} runs {seconds:.1f} s, outside 20 to 35 s")
        if size > 4 * 1048576:
            print(f"  warning: {target.name} is over 4 MB")
        if MARKS:
            starts = [max(0.0, round(t - started - loaded, 1)) for t in MARKS]
            starts[0] = 0.0
            write_chapters(name, theme, starts)
            print(f"  chapters {starts}")
    if name in COLD_TAKES:
        # Back to the data the later clips build on.
        server.stop()
        server.start(snapshot)


def write_chapters(name: str, theme: str, starts: list[float]) -> None:
    """Merge one clip's chapter starts for one theme into clipChapters.json."""
    data = json.loads(CHAPTERS_FILE.read_text(encoding="utf-8")) if CHAPTERS_FILE.exists() else {}
    data.setdefault(name, {})[theme] = starts
    CHAPTERS_FILE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


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
    if not (ROOT / "playground" / "frontend" / "dist" / "index.html").exists():
        raise SystemExit("playground/frontend/dist is missing: run `npm run build` in playground/frontend/ first")
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
