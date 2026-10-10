"""A real-browser smoke test of the main flows, against a local demo server.

    uv run --with playwright==1.55.0 playwright install chromium     # once
    cd web && npm run build && cd ..                                # the page under test
    uv run --with playwright==1.55.0 pytest -m smoke

Deselected by default, like the `models` tests: it needs the Docling and Qwen3
models and a built web app, and takes a few minutes. Run it before publishing a
tag to the demo.

One server for the session, started the way `scripts/record_clips.py` starts
its own: demo mode, a fresh temp data folder, a free port, stopped by its own
process. The flows run once at 1440 px in the light theme, on the first bundled
sample, the way a visitor arrives: Home, Build the index, Ask, Compare,
Evaluate. Then every page is opened at 1440 and 390 px, light and dark, and
must not scroll sideways or log a console error.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.smoke

ROOT = Path(__file__).resolve().parents[2]
#: The flows run on real models, so each wait is generous.
LONG = 600_000
PAGES = ["/", "/build", "/compare", "/evaluate", "/library", "/read", "/privacy"]
WIDTHS = {"desktop": {"width": 1440, "height": 900}, "phone": {"width": 390, "height": 844}}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def base():
    """A demo server of our own on a free port, with its data in a temp folder."""
    if not (ROOT / "web" / "dist" / "index.html").exists():
        pytest.skip("no web build: run `npm run build` in web/ first")
    port = _free_port()
    data = Path(tempfile.mkdtemp(prefix="rag-smoke-"))
    env = {
        **os.environ,
        "RAG_PLAYGROUND_ARTIFACTS": str(data / "artifacts"),
        "RAG_PLAYGROUND_SOURCES": str(data / "sources"),
        "RAG_PLAYGROUND_DEMO": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 120
        while True:
            if proc.poll() is not None:
                pytest.fail(f"the server exited with code {proc.returncode} before it answered")
            try:
                urllib.request.urlopen(url + "/api/registry", timeout=2)
                break
            except OSError:
                if time.time() > deadline:
                    pytest.fail("the server did not start within 2 minutes")
                time.sleep(0.5)
        yield url
    finally:
        # Only our own process, by its handle.
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope="session")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api", reason="run with `uv run --with playwright==1.55.0`")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def _watch(page) -> list[str]:
    """Collect console errors and uncaught page errors as they happen."""
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return errors


def _sideways(page) -> int:
    """How many pixels the page scrolls sideways; 0 when it does not."""
    return page.evaluate("document.documentElement.scrollWidth - window.innerWidth")


def test_the_main_flows_work_end_to_end(base, browser):
    ctx = browser.new_context(viewport=WIDTHS["desktop"], color_scheme="light")
    page = ctx.new_page()
    errors = _watch(page)

    # Home, then Build on the first sample, the way a visitor arrives.
    page.goto(base + "/")
    page.get_by_role("button", name="Try it yourself on Build").click()
    page.wait_for_url("**/build")

    # Build the index, then ask once it is ready.
    page.get_by_role("button", name="Build the index").click()
    page.get_by_text(re.compile(r"^Index ready")).wait_for(timeout=LONG)
    page.get_by_placeholder(re.compile(r"^Ask something about")).fill("Why do chunk boundaries matter?")
    page.get_by_role("button", name="Ask", exact=True).click()
    # Answer first: the pieces that came back, then the invite to try again.
    page.get_by_text("Try another search or a reranker, and ask again.").wait_for(timeout=LONG)
    assert page.get_by_role("button", name="Show in PDF").count() > 0, "no pieces came back for the question"

    # Compare: the default recipes run and the finding sentence appears.
    page.goto(base + "/compare")
    run = page.get_by_role("button", name=re.compile(r"^Run \d+ recipes$"))
    run.click()
    # A fast machine can finish before a poll ever sees Stop the run, so wait for
    # the results and then for the run to close, not for the Stop button.
    finding = page.get_by_test_id("compare-finding")
    try:
        finding.wait_for(timeout=LONG)
        page.get_by_role("button", name="Stop the run").wait_for(state="hidden", timeout=LONG)
        run.wait_for(timeout=LONG)
    except Exception as e:
        raise AssertionError(f"Compare did not finish: {page.locator('main').inner_text()[:1500]}") from e
    assert finding.inner_text().strip(), "Compare finished without a finding sentence"

    # Evaluate: the question set runs and the score is a sentence.
    page.goto(base + "/evaluate")
    page.get_by_role("button", name="Evaluate", exact=True).click()
    page.get_by_role("button", name="Evaluate again").wait_for(timeout=LONG)
    page.get_by_text(re.compile(r"^\d+ of \d+ questions found the answer\.")).wait_for()

    assert errors == [], f"console errors: {errors}"
    ctx.close()


@pytest.mark.parametrize("theme", ["light", "dark"])
@pytest.mark.parametrize("width", list(WIDTHS))
def test_no_page_scrolls_sideways_or_logs_an_error(base, browser, width, theme):
    ctx = browser.new_context(viewport=WIDTHS[width], color_scheme=theme)
    page = ctx.new_page()
    errors = _watch(page)
    wide: dict[str, int] = {}
    for path in PAGES:
        page.goto(base + path)
        page.wait_for_load_state("networkidle")
        if (px := _sideways(page)) > 0:
            wide[path] = px
    assert wide == {}, f"pages that scroll sideways at {width} {theme} (px): {wide}"
    assert errors == [], f"console errors at {width} {theme}: {errors}"
    ctx.close()
