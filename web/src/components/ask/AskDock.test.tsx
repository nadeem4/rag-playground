import { readFileSync } from "node:fs"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FakeResizeObserver } from "@/routes/fakeResizeObserver"
import { buildCss } from "@/styles/compileCss"

import { AskDock, DOCK_KEY, SHEET_QUERY, DESKTOP_QUERY, useAskDock } from "./AskDock"
import { useComparisonWide } from "./useWide"

/** The width of Build in these tests: the panel may grow to 1440 - 380 - 360 - 2 = 698 px. */
const BUILD_WIDTH = 1440
const MAX = 698

function Probe() {
  return <p data-testid="probe">{useComparisonWide() ? "wide" : "narrow"}</p>
}

function Harness({ count, buildWidth = BUILD_WIDTH, details = false }: { count?: number; buildWidth?: number; details?: boolean }) {
  const dock = useAskDock()
  return (
    <main>
      <p data-testid="state">{`${dock.open ? "open" : "closed"} ${dock.side} ${dock.width}`}</p>
      <input aria-label="Chunk size" />
      <AskDock dock={dock} count={count} measure={() => buildWidth}>
        {(head) => (
          <section aria-label="Ask panel">
            <div>
              <h2>Ask</h2>
              {head}
            </div>
            <label>
              Question
              <textarea />
            </label>
            <button type="button">Change settings</button>
            {details ? (
              <details>
                <summary>Show search order</summary>
                <button type="button">Folded away</button>
              </details>
            ) : null}
            <Probe />
          </section>
        )}
      </AskDock>
    </main>
  )
}

const CLOSE = "Close Ask. Your question and results are kept."
const dockEl = () => document.getElementById("ask-dock") as HTMLElement
const fab = () => screen.getByRole("button", { name: /^Ask/, expanded: false })
const separator = () => screen.getByRole("separator", { name: "Resize the Ask panel" })
const question = () => screen.getByLabelText("Question") as HTMLTextAreaElement
const stored = () => JSON.parse(window.localStorage.getItem(DOCK_KEY) ?? "null") as { open: boolean; side: string; width: number } | null
const altA = (key = "a") => fireEvent.keyDown(document, { key, code: "KeyA", altKey: true })

/** The stubbed window: `below` is below lg (the sheet), `desktop` is lg and up. */
const media = { below: false, desktop: true, listeners: new Set<() => void>() }

/** Stubs matchMedia with the window's size; `resizeTo` changes it later and tells the listeners. */
function screenSize({ below = false, desktop = true }: { below?: boolean; desktop?: boolean }) {
  media.below = below
  media.desktop = desktop
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      get matches() {
        return q === SHEET_QUERY ? media.below : q === DESKTOP_QUERY ? media.desktop : false
      },
      addEventListener: (_: string, f: () => void) => media.listeners.add(f),
      removeEventListener: (_: string, f: () => void) => media.listeners.delete(f),
    })),
  )
}

function resizeTo({ below, desktop }: { below: boolean; desktop: boolean }) {
  media.below = below
  media.desktop = desktop
  act(() => media.listeners.forEach((f) => f()))
}

/** jsdom draws nothing, so `checkVisibility` is stubbed: hidden inside a closed details (its own summary aside) or a hidden box. */
function stubVisibility() {
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value(this: HTMLElement) {
      const folded = this.parentElement?.closest("details:not([open])")
      if (folded && !(this.tagName === "SUMMARY" && this.parentElement === folded)) return false
      return !this.closest("[hidden]")
    },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  FakeResizeObserver.reset()
})

afterEach(() => {
  cleanup()
  media.listeners.clear()
  delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the docked Ask panel", () => {
  it("is open on the right by default on a desktop, with its head and a resize edge", () => {
    render(<Harness />)
    const aside = screen.getByRole("complementary", { name: "Ask" })
    expect(aside.getAttribute("data-side")).toBe("right")
    expect(screen.getByRole("button", { name: CLOSE })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Move the panel to the left" })).toBeTruthy()
    const edge = separator()
    expect(edge.getAttribute("aria-orientation")).toBe("vertical")
    expect(edge.getAttribute("aria-valuemin")).toBe("320")
    // The most the panel can take here: 1440 - 380 - 360 - 2.
    expect(edge.getAttribute("aria-valuemax")).toBe(String(MAX))
    expect(edge.getAttribute("aria-valuenow")).toBe("440")
    // The open button shows only while the panel is closed.
    expect(screen.queryByRole("button", { name: /^Ask/, expanded: false })).toBeNull()
  })

  it("is a sheet below lg and docks from lg: the sheet's query is the lg edge, and only lg classes dock it", () => {
    expect(SHEET_QUERY).toBe("(max-width: 63.99rem)")
    expect(DESKTOP_QUERY).toBe("(min-width: 64rem)")
    render(<Harness />)
    const tokens = dockEl().className.split(/\s+/)
    expect(tokens).toContain("lg:relative")
    expect(tokens.filter((t) => t.startsWith("md:"))).toEqual([])
    const css = readFileSync(`${__dirname}/../../styles/tokens.css`, "utf8")
    expect(css).toContain("@media (prefers-reduced-motion: no-preference) and (max-width: 1023px)")
    expect(css).not.toContain("@media (prefers-reduced-motion: no-preference) and (max-width: 767px)")
  })

  it("at 1024 px the edge reads the 320 px it shows, before any key, and the stored 440 survives the keys", () => {
    render(<Harness buildWidth={1024} />)
    expect(separator().getAttribute("aria-valuenow")).toBe("320")
    expect(separator().getAttribute("aria-valuemax")).toBe("320")
    fireEvent.keyDown(separator(), { key: "ArrowLeft" })
    expect(separator().getAttribute("aria-valuenow")).toBe("320")
    fireEvent.keyDown(separator(), { key: "End" })
    fireEvent.keyDown(separator(), { key: "ArrowLeft", shiftKey: true })
    expect(separator().getAttribute("aria-valuenow")).toBe("320")
    expect(screen.getByTestId("state").textContent).toBe("open right 440")
    expect(stored()?.width).toBe(440)
  })

  it("a narrower window narrows what is shown, not what is stored; widening it again gives the width back", () => {
    const view = render(<Harness />)
    expect(separator().getAttribute("aria-valuenow")).toBe("440")
    view.rerender(<Harness buildWidth={1024} />)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(separator().getAttribute("aria-valuenow")).toBe("320")
    expect(stored()?.width).toBe(440)
    view.rerender(<Harness buildWidth={1440} />)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(separator().getAttribute("aria-valuenow")).toBe("440")
  })

  it("dragging at a narrow window starts from what is shown", () => {
    render(<Harness buildWidth={1100} />)
    // The most here is 1100 - 742 = 358; the stored 440 shows as 358.
    expect(separator().getAttribute("aria-valuenow")).toBe("358")
    fireEvent.pointerDown(separator(), { pointerId: 1, clientX: 500, button: 0 })
    fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 520 })
    expect(separator().getAttribute("aria-valuenow")).toBe("338")
    fireEvent.pointerUp(separator(), { pointerId: 1, clientX: 520 })
  })

  it("on a touch screen, most of the edge's hit area lies outside the panel, so taps inside reach its controls", () => {
    const css = readFileSync(`${__dirname}/../../styles/tokens.css`, "utf8")
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {\n  .ask-edge"))
    expect(coarse).toMatch(/\[data-side="right"\] > \.ask-edge \{\s*left: -34px;/)
    expect(coarse).toMatch(/\[data-side="left"\] > \.ask-edge \{\s*right: -34px;/)
  })

  it("closing keeps what is inside; reopening shows it again, and focus moves to the question and back to the button", () => {
    render(<Harness />)
    fireEvent.change(question(), { target: { value: "How long did the survey run?" } })
    fireEvent.click(screen.getByRole("button", { name: CLOSE }))
    expect(dockEl().hidden).toBe(true)
    expect(document.activeElement).toBe(fab())
    fireEvent.click(fab())
    expect(dockEl().hidden).toBe(false)
    expect(question().value).toBe("How long did the survey run?")
    expect(document.activeElement).toBe(question())
  })

  it("the round button shows how many results the last question found", () => {
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: CLOSE }))
    expect(fab().textContent).toBe("Ask")
    rerender(<Harness count={3} />)
    expect(screen.getByRole("button", { name: "Ask 3 results" })).toBeTruthy()
    rerender(<Harness count={1} />)
    expect(screen.getByRole("button", { name: "Ask 1 result" })).toBeTruthy()
  })

  it("the side switch moves the panel to the other edge and back, keeping focus on itself", () => {
    render(<Harness />)
    const toLeft = screen.getByRole("button", { name: "Move the panel to the left" })
    toLeft.focus()
    fireEvent.click(toLeft)
    expect(dockEl().getAttribute("data-side")).toBe("left")
    const back = screen.getByRole("button", { name: "Move the panel to the right" })
    expect(document.activeElement).toBe(back)
    expect(stored()?.side).toBe("left")
    fireEvent.click(back)
    expect(dockEl().getAttribute("data-side")).toBe("right")
  })
})

describe("resizing the panel", () => {
  const width = () => Number(separator().getAttribute("aria-valuenow"))

  it("the arrow keys move the edge by 20 px, or 80 px with Shift; Home and End jump to the ends; the main pane keeps 360 px", () => {
    render(<Harness />)
    const edge = separator()
    // Docked on the right, the edge is the panel's left side: left widens it.
    fireEvent.keyDown(edge, { key: "ArrowLeft" })
    expect(width()).toBe(460)
    fireEvent.keyDown(edge, { key: "ArrowLeft", shiftKey: true })
    expect(width()).toBe(540)
    fireEvent.keyDown(edge, { key: "ArrowRight" })
    expect(width()).toBe(520)
    fireEvent.keyDown(edge, { key: "End" })
    expect(width()).toBe(MAX)
    fireEvent.keyDown(edge, { key: "ArrowLeft", shiftKey: true })
    expect(width()).toBe(MAX)
    fireEvent.keyDown(edge, { key: "Home" })
    expect(width()).toBe(320)
    fireEvent.keyDown(edge, { key: "ArrowRight" })
    expect(width()).toBe(320)
    expect(stored()?.width).toBe(320)
  })

  it("on the left, the right arrow widens it", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Move the panel to the left" }))
    fireEvent.keyDown(separator(), { key: "ArrowRight" })
    expect(width()).toBe(460)
    fireEvent.keyDown(separator(), { key: "ArrowLeft", shiftKey: true })
    expect(width()).toBe(380)
  })

  it("dragging the edge resizes it, clamped at both ends", () => {
    render(<Harness />)
    const edge = separator()
    fireEvent.pointerDown(edge, { pointerId: 1, clientX: 1000, button: 0 })
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 900 })
    expect(width()).toBe(540)
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 0 })
    expect(width()).toBe(MAX)
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 1400 })
    expect(width()).toBe(320)
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 960 })
    expect(width()).toBe(480)
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 960 })
    // After the button is released, a move does nothing.
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 700 })
    expect(width()).toBe(480)
    expect(stored()?.width).toBe(480)
  })

  it("dragging on the left side follows the pointer the other way", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Move the panel to the left" }))
    const edge = separator()
    fireEvent.pointerDown(edge, { pointerId: 1, clientX: 440, button: 0 })
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 500 })
    expect(width()).toBe(500)
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 500 })
  })
})

describe("Alt+A", () => {
  it("closes and opens the panel, moving focus to the button and to the question", () => {
    render(<Harness />)
    altA()
    expect(dockEl().hidden).toBe(true)
    expect(document.activeElement).toBe(fab())
    altA("A")
    expect(dockEl().hidden).toBe(false)
    expect(document.activeElement).toBe(question())
    // On a Mac, Option+A types å; the key code is still KeyA.
    altA("å")
    expect(dockEl().hidden).toBe(true)
  })

  it("does nothing without Alt", () => {
    render(<Harness />)
    fireEvent.keyDown(document, { key: "a", code: "KeyA" })
    expect(dockEl().hidden).toBe(false)
  })

  it("does nothing on a held key's repeats", () => {
    render(<Harness />)
    fireEvent.keyDown(document, { key: "a", code: "KeyA", altKey: true, repeat: true })
    expect(dockEl().hidden).toBe(false)
  })

  it("leaves a field elsewhere on the page alone", () => {
    render(<Harness />)
    const field = screen.getByLabelText("Chunk size")
    field.focus()
    fireEvent.keyDown(field, { key: "a", code: "KeyA", altKey: true })
    expect(dockEl().hidden).toBe(false)
    expect(document.activeElement).toBe(field)
  })

  it("in the question box it answers only to the a key, so Option+A still types å on a Mac", () => {
    render(<Harness />)
    question().focus()
    fireEvent.keyDown(question(), { key: "å", code: "KeyA", altKey: true })
    expect(dockEl().hidden).toBe(false)
    fireEvent.keyDown(question(), { key: "a", code: "KeyA", altKey: true })
    expect(dockEl().hidden).toBe(true)
  })
})

describe("remembered settings", () => {
  it("the side, the width and open or closed come back on the next visit", () => {
    const first = render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Move the panel to the left" }))
    fireEvent.keyDown(separator(), { key: "ArrowRight", shiftKey: true })
    fireEvent.click(screen.getByRole("button", { name: CLOSE }))
    expect(stored()).toEqual({ open: false, side: "left", width: 520 })
    first.unmount()
    render(<Harness />)
    expect(screen.getByTestId("state").textContent).toBe("closed left 520")
  })

  it("an unreadable or out of range record falls back to the defaults, within bounds", () => {
    window.localStorage.setItem(DOCK_KEY, "{not json")
    const first = render(<Harness />)
    expect(screen.getByTestId("state").textContent).toBe("open right 440")
    first.unmount()
    window.localStorage.setItem(DOCK_KEY, JSON.stringify({ open: "yes", side: "top", width: 5000 }))
    render(<Harness />)
    expect(screen.getByTestId("state").textContent).toBe("open right 960")
  })

  it("blocked storage changes nothing: the panel works and nothing throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    render(<Harness />)
    expect(dockEl().hidden).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Move the panel to the left" }))
    fireEvent.keyDown(separator(), { key: "ArrowRight" })
    fireEvent.click(screen.getByRole("button", { name: CLOSE }))
    expect(screen.getByTestId("state").textContent).toBe("closed left 460")
  })
})

describe("below lg, a bottom sheet", () => {
  beforeEach(() => {
    screenSize({ below: true, desktop: false })
    stubVisibility()
  })

  it("the page behind it stays still while it is open, and scrolls again once it closes", () => {
    document.documentElement.style.overflow = ""
    document.body.style.overflow = "scroll"
    render(<Harness />)
    const main = document.querySelector("main")!
    fireEvent.click(fab())
    expect(document.documentElement.style.overflow).toBe("hidden")
    expect(document.body.style.overflow).toBe("hidden")
    expect(main.style.overflow).toBe("hidden")
    fireEvent.keyDown(question(), { key: "Escape" })
    expect(document.documentElement.style.overflow).toBe("")
    expect(document.body.style.overflow).toBe("scroll")
    expect(main.style.overflow).toBe("")
    document.body.style.overflow = ""
  })

  it("a closed sheet never locks the page", () => {
    render(<Harness />)
    expect(document.body.style.overflow).toBe("")
  })

  it("starts closed, even when it was left open, and opens as a modal sheet with a grab line and no resize edge or side switch", () => {
    window.localStorage.setItem(DOCK_KEY, JSON.stringify({ open: true, side: "left", width: 500 }))
    render(<Harness />)
    expect(dockEl().hidden).toBe(true)
    fireEvent.click(fab())
    const sheet = screen.getByRole("dialog", { name: "Ask" })
    expect(sheet.getAttribute("aria-modal")).toBe("true")
    expect(sheet.querySelector("[data-grab]")).toBeTruthy()
    expect(screen.queryByRole("separator")).toBeNull()
    expect(screen.queryByRole("button", { name: /Move the panel/ })).toBeNull()
    expect(document.activeElement).toBe(question())
  })

  it("Escape closes it and focus returns to the button", () => {
    render(<Harness />)
    fireEvent.click(fab())
    fireEvent.keyDown(question(), { key: "Escape" })
    expect(dockEl().hidden).toBe(true)
    expect(document.activeElement).toBe(fab())
  })

  it("traps focus while open: Tab from the last control goes to the first, Shift+Tab from the first to the last", () => {
    render(<Harness />)
    fireEvent.click(fab())
    const close = screen.getByRole("button", { name: CLOSE })
    const last = screen.getByRole("button", { name: "Change settings" })
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it("skips what a closed disclosure hides: Tab from its summary goes to the first control", () => {
    render(<Harness details />)
    fireEvent.click(fab())
    const close = screen.getByRole("button", { name: CLOSE })
    const summary = screen.getByText("Show search order")
    summary.focus()
    fireEvent.keyDown(summary, { key: "Tab" })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(summary)
  })

  it("brings focus back inside when it has got out", () => {
    render(<Harness />)
    fireEvent.click(fab())
    const field = screen.getByLabelText("Chunk size")
    field.focus()
    expect(dockEl().contains(document.activeElement)).toBe(true)
  })

  it("the backdrop closes it, over the scrim colour", () => {
    render(<Harness />)
    fireEvent.click(fab())
    const backdrop = screen.getByTestId("ask-backdrop")
    expect(backdrop.className.split(/\s+/)).toContain("bg-(--scrim)")
    fireEvent.click(backdrop)
    expect(dockEl().hidden).toBe(true)
  })

  it("the scrim is a token, darker in the dark theme", () => {
    const css = readFileSync(`${__dirname}/../../styles/tokens.css`, "utf8")
    const values = [...css.matchAll(/--scrim: ([^;]+);/g)].map((m) => m[1])
    expect(values[0]).toBe("rgb(0 0 0 / 0.4)")
    expect(values.slice(1)).toEqual(["rgb(0 0 0 / 0.6)", "rgb(0 0 0 / 0.6)"])
  })
})

describe("switching between the dock and the sheet", () => {
  it("an open dock closes without moving focus when the window drops below lg, and the stored desktop state stays open", () => {
    screenSize({ below: false, desktop: true })
    render(<Harness />)
    const field = screen.getByLabelText("Chunk size")
    field.focus()
    resizeTo({ below: true, desktop: false })
    expect(dockEl().hidden).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(stored()?.open).toBe(true)
    // Opening and closing the sheet does not touch the desktop state.
    fireEvent.click(fab())
    fireEvent.keyDown(question(), { key: "Escape" })
    expect(stored()?.open).toBe(true)
    // Back at lg, the dock is open again, as it was left there.
    resizeTo({ below: false, desktop: true })
    expect(dockEl().hidden).toBe(false)
  })

  it("a dock closed on a desktop stays closed in storage after a sheet is opened below lg", () => {
    window.localStorage.setItem(DOCK_KEY, JSON.stringify({ open: false, side: "right", width: 440 }))
    screenSize({ below: true, desktop: false })
    render(<Harness />)
    fireEvent.click(fab())
    expect(dockEl().hidden).toBe(false)
    expect(stored()?.open).toBe(false)
  })
})

describe("the comparison follows the panel's own width", () => {
  it("narrow below 640 px of panel, wide from 640 px", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    FakeResizeObserver.width = 500
    render(<Harness />)
    expect(screen.getByTestId("probe").textContent).toBe("narrow")
    act(() => FakeResizeObserver.all.forEach((o) => o.report(700)))
    expect(screen.getByTestId("probe").textContent).toBe("wide")
    act(() => FakeResizeObserver.all.forEach((o) => o.report(639)))
    expect(screen.getByTestId("probe").textContent).toBe("narrow")
  })

  it("outside the panel, the switch still follows the window", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    render(<Probe />)
    expect(screen.getByTestId("probe").textContent).toBe("narrow")
  })
})

describe("the settings blocks follow the panel's own width", () => {
  it("the dock is a size container, and three settings blocks sit side by side only from 840 px of panel", async () => {
    render(<Harness />)
    expect(dockEl().className.split(/\s+/)).toContain("@container")
    const settings = readFileSync(`${__dirname}/AskSettings.tsx`, "utf8")
    expect(settings).toContain("grid grid-cols-1 gap-3 @min-[840px]:grid-cols-3")
    expect(settings).not.toContain("lg:grid-cols-3")
    const css = await buildCss(["@container", "@min-[840px]:grid-cols-3"])
    expect(css).toMatch(/@container \(width >= 840px\)|@container \(min-width: 840px\)/)
  })
})
