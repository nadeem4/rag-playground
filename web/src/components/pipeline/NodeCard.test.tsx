import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import type { NodeState } from "@/api/runState"
import { initialGraph, transformsFor } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { describeResult, NodeCard, type NodeCardProps } from "./NodeCard"

/** A start time `ago` seconds before a frozen clock, so a slow machine cannot tick the shown seconds over. */
const FROZEN_MS = 1_800_000_000_000
function startedAgo(ago: number): number {
  vi.useFakeTimers({ now: FROZEN_MS, toFake: ["Date"] })
  return FROZEN_MS / 1000 - ago
}
afterEach(() => vi.useRealTimers())


/** Payloads by artifact id. Ids are unique per test: payloads are cached for the session. */
let payloads: Record<string, unknown> = {}

beforeEach(() => {
  payloads = {}
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      const payload = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (payload) return ok(payloads[payload[1]])
      const meta = /^\/api\/artifacts\/([^/]+)$/.exec(url)
      if (meta) return ok({ id: meta[1], type: "chunk_set", meta: {} })
      return ok([])
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const chunkNode = initialGraph(R).nodes.find((n) => n.stage === "chunk")!

function renderCard(over: Partial<NodeCardProps> = {}) {
  const props: NodeCardProps = {
    node: chunkNode,
    title: "Chunk",
    transforms: transformsFor(R, "chunk"),
    selected: false,
    busy: false,
    onSelect: vi.fn(),
    onTransform: vi.fn(),
    onConfig: vi.fn(),
    onRun: vi.fn(),
    ...over,
  }
  render(<NodeCard {...props} />)
  return screen.getByRole("article")
}

const done = (artifact_id: string, status: "done" | "cached" = "done"): NodeState => ({
  id: "chunk",
  status,
  artifact_id,
  cache_hit: status === "cached",
  duration_ms: 3,
})

describe("describeResult", () => {
  it("names five looks and says changed, run again for a stale result", () => {
    expect(describeResult(undefined, false).look).toBe("idle")
    expect(describeResult({ id: "x", status: "running" }, false).look).toBe("running")
    expect(describeResult(done("a"), false).look).toBe("done")
    expect(describeResult(done("a", "cached"), false).look).toBe("done")
    expect(describeResult(done("a"), true)).toMatchObject({ look: "stale", label: "changed, run again" })
    expect(describeResult({ id: "x", status: "failed", error: "boom" }, false).look).toBe("failed")
    expect(describeResult(done("a"), false)).not.toHaveProperty("rule")
  })
})

describe("the step card's look", () => {
  it("idle: a 14 px ring with a 2 px field-border stroke and an empty centre, no bar, no summary", () => {
    const card = renderCard()
    expect(card.dataset.look).toBe("idle")
    expect(card.hasAttribute("data-rule")).toBe(false)
    expect(card.style.borderLeft).toBe("")
    const ring = within(card).getByTestId("status-ring")
    expect(ring.className).toContain("border-field-border")
    expect(ring.className).toContain("size-[14px]")
    expect(ring.className).toContain("border-2")
    expect(within(ring).queryByTestId("ring-dot")).toBeNull()
    expect(within(card).queryByTestId("running-bar")).toBeNull()
    expect(within(card).queryByTestId("step-summary")).toBeNull()
  })

  it("running: the accent at half strength and the breathing top edge", () => {
    const card = renderCard({ result: { id: "chunk", status: "running" } })
    expect(card.dataset.look).toBe("running")
    expect(within(card).getByTestId("status-ring").className).toContain("bg-primary/50")
    const bar = within(card).getByTestId("running-bar")
    expect(bar.className).toContain("step-running-edge")
    expect(bar.className).toContain("top-0")
  })

  it("done: a solid ring with an accent dot, and the outcome on one line, without (was N), headline in bold", async () => {
    payloads = { look1: chunkRecursive }
    const card = renderCard({ result: done("look1"), previousArtifactId: "look0" })
    expect(card.dataset.look).toBe("done")
    const ring = within(card).getByTestId("status-ring")
    expect(ring.className).toContain("border-primary")
    expect(ring.className).not.toContain("border-dashed")
    expect(within(ring).getByTestId("ring-dot").className).toContain("bg-primary")
    const sentence = "Made 6 chunks. Median 67 tokens, largest 76. 3 overlaps."
    const summary = await within(card).findByTestId("step-summary", {}, { timeout: 4000 })
    expect(summary.textContent).toBe(sentence)
    expect(summary.getAttribute("title")).toBe(sentence)
    expect(summary.className).toContain("truncate")
    expect(summary.className).not.toContain("font-mono")
    expect(within(summary).getByText("6").className).toContain("font-semibold")
    expect(within(summary).getByText("67").className).toContain("font-mono")
    // A computed result has no chip.
    expect(within(card).queryByTestId("status-chip")).toBeNull()
  })

  it("done from the cache: the same result line, a dashed ring and the reused chip", async () => {
    payloads = { look2: chunkRecursive }
    const card = renderCard({ result: done("look2", "cached") })
    expect(card.dataset.look).toBe("done")
    expect(within(card).getByTestId("status-ring").className).toContain("border-dashed")
    expect(within(card).getByTestId("status-chip").textContent).toBe("reused from an earlier run")
    const summary = await within(card).findByTestId("step-summary", {}, { timeout: 4000 })
    expect(summary.textContent).toBe("Made 6 chunks. Median 67 tokens, largest 76. 3 overlaps.")
  })

  it("the Chunk card shows its pieces to scale in the chunk colours", async () => {
    payloads = { bar1: chunkRecursive }
    const card = renderCard({ result: done("bar1") })
    const bar = await within(card).findByTestId("chunk-bar")
    const pieces = [...bar.children] as HTMLElement[]
    expect(pieces).toHaveLength(chunkRecursive.chunks.length)
    pieces.forEach((el, i) => {
      expect(el.className).toContain(`bg-chunk-${(i % 8) + 1}`)
      expect(el.style.flexGrow).toBe(String(chunkRecursive.chunks[i].token_count))
    })
    expect(bar.className).toContain("h-[4px]")
  })

  it("stale: an amber ring and the status word changed, run again", () => {
    const card = renderCard({ result: done("look3"), stale: true })
    expect(card.dataset.look).toBe("stale")
    expect(within(card).getByTestId("status-ring").className).toContain("border-stale")
    const chip = within(card).getByTestId("status-chip")
    expect(chip.textContent).toBe("changed, run again")
    expect(chip.className).toContain("rounded-full")
    expect(chip.className).toContain("text-stale")
    expect(card.textContent).not.toContain("changed, not run")
  })

  it("failed: a danger ring", () => {
    const card = renderCard({ result: { id: "chunk", status: "failed", error: "ValueError: boom" } })
    expect(card.dataset.look).toBe("failed")
    expect(within(card).getByTestId("status-ring").className).toContain("border-danger")
  })

  it("the duration is in mono", () => {
    payloads = { look4: chunkRecursive }
    const card = renderCard({ result: done("look4", "cached") })
    expect(within(card).getByText("3.0 ms").className).toContain("font-mono")
  })
})

describe("the transform line", () => {
  it("gives the plain name, then the code name in mono, and never truncates", () => {
    const card = renderCard()
    const line = within(card).getByTestId("step-transform")
    expect(line.textContent).toBe("Recursive (natural breaks), recursive_character")
    const code = within(line).getByText("recursive_character")
    expect(code.className).toContain("font-mono")
    expect(code.className).toContain("text-2xs")
    expect(line.className).not.toContain("truncate")
    expect(card.querySelector("header .truncate")).toBeNull()
  })

  it("the picker's options read the same way", () => {
    const card = renderCard()
    expect(within(card).getByRole("option", { name: "Recursive (natural breaks), recursive_character" })).toBeTruthy()
  })
})

describe("raised and open", () => {
  it("the selected card is raised and open; another is flat and closed", () => {
    const card = renderCard({ selected: true })
    expect(card.className).toContain("shadow-raised")
    expect(card.className).toContain("bg-surface-raised")
    expect(within(card).getByRole("button", { name: "Chunk" }).getAttribute("aria-expanded")).toBe("true")
    const body = within(card).getByTestId("step-options")
    expect(body.className).toContain("grid-rows-[1fr]")
    expect(body.className).toContain("duration-(--dur-mid)")
    expect(body.className).toContain("ease-(--ease-in)")
    expect(body.className).toContain("motion-reduce:transition-none")
    cleanup()

    const flat = renderCard({ selected: false })
    expect(flat.className).not.toContain("shadow-raised")
    expect(flat.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-surface", "rounded-panel", "border", "border-hairline"]))
    expect(within(flat).getByRole("button", { name: "Chunk" }).getAttribute("aria-expanded")).toBe("false")
    expect(within(flat).getByTestId("step-options").className).toContain("grid-rows-[0fr]")
  })
})

describe("click to close, and scroll into view", () => {
  it("the head selects a closed card and deselects the selected one; a button's keys reach it as a click", () => {
    const onSelect = vi.fn()
    const onDeselect = vi.fn()
    renderCard({ selected: false, onSelect, onDeselect })
    fireEvent.click(screen.getByRole("button", { name: "Chunk" }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onDeselect).not.toHaveBeenCalled()
    cleanup()

    const onSelect2 = vi.fn()
    const onDeselect2 = vi.fn()
    renderCard({ selected: true, onSelect: onSelect2, onDeselect: onDeselect2 })
    fireEvent.click(screen.getByRole("button", { name: "Chunk" }))
    expect(onDeselect2).toHaveBeenCalledTimes(1)
    expect(onSelect2).not.toHaveBeenCalled()
  })

  it("a closed card tints and darkens its hairline on hover; the selected card does not", () => {
    const flat = renderCard({ selected: false })
    expect(flat.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["hover:bg-surface-raised", "hover:border-field-border", "transition-colors", "duration-(--dur-fast)"]),
    )
    expect(flat.className).not.toMatch(/hover:(shadow|scale|-?translate)/)
    cleanup()
    const raised = renderCard({ selected: true })
    expect(raised.className).not.toContain("hover:bg-surface-raised")
    expect(raised.className).not.toContain("hover:border-field-border")
  })

  it("the chevron at the end of the head says Expand when closed and Collapse when open", () => {
    const flat = renderCard({ selected: false })
    const expand = within(flat).getByRole("button", { name: "Expand Chunk" })
    expect(expand.getAttribute("aria-expanded")).toBe("false")
    expect(expand.closest("header")).not.toBeNull()
    const icon = expand.querySelector("svg")!
    expect(icon.getAttribute("width")).toBe("16")
    expect(icon.getAttribute("class")).toContain("duration-(--dur-fast)")
    expect(icon.getAttribute("class")).toContain("motion-reduce:transition-none")
    expect(icon.getAttribute("class")).not.toContain("rotate-180")
    expect(within(flat).queryByRole("button", { name: "Collapse Chunk" })).toBeNull()
    cleanup()

    const open = renderCard({ selected: true })
    const collapse = within(open).getByRole("button", { name: "Collapse Chunk" })
    expect(collapse.getAttribute("aria-expanded")).toBe("true")
    expect(collapse.querySelector("svg")!.getAttribute("class")).toContain("rotate-180")
  })

  it("the chevron toggles the card the way the head does", () => {
    const onSelect = vi.fn()
    const onDeselect = vi.fn()
    renderCard({ selected: true, onSelect, onDeselect })
    fireEvent.click(screen.getByRole("button", { name: "Collapse Chunk" }))
    expect(onDeselect).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    cleanup()

    const onSelect2 = vi.fn()
    const onDeselect2 = vi.fn()
    renderCard({ selected: false, onSelect: onSelect2, onDeselect: onDeselect2 })
    fireEvent.click(screen.getByRole("button", { name: "Expand Chunk" }))
    expect(onSelect2).toHaveBeenCalledTimes(1)
    expect(onDeselect2).not.toHaveBeenCalled()
  })

  it("the chevron follows selection: a card open only for a field error still reads Expand", () => {
    const card = renderCard({ selected: false, fieldErrors: { chunk_size: ["Too small"] } })
    const chevron = within(card).getByRole("button", { name: "Expand Chunk" })
    expect(chevron.getAttribute("aria-expanded")).toBe("false")
  })

  it("the chevron sits on the title row, not in the group that wraps", () => {
    const card = renderCard({ selected: false, showId: true, onRemove: vi.fn(), result: { id: "chunk", status: "failed", error: "x" } })
    const chevron = within(card).getByRole("button", { name: "Expand Chunk" })
    const row = chevron.parentElement!
    expect(row.querySelector("h3")).not.toBeNull()
    expect(row.contains(within(card).getByTestId("status-chip"))).toBe(false)
    expect(row.className.split(/\s+/)).not.toContain("flex-wrap")
  })

  it("the Document card has no chevron", () => {
    const source = initialGraph(R).nodes.find((n) => n.stage === "source")!
    const card = renderCard({ node: source, title: "Document", transforms: transformsFor(R, "source") })
    expect(within(card).queryByRole("button", { name: /^(Expand|Collapse) / })).toBeNull()
  })

  describe("the Document card", () => {
    const source = initialGraph(R).nodes.find((n) => n.stage === "source")!
    const withFile = { ...source, config: { sha: "ab".repeat(32), filename: "report.pdf" } }

    it("names the document and points to the bar, with nothing to edit when open", () => {
      const card = renderCard({ node: withFile, title: "Document", transforms: transformsFor(R, "source"), selected: true })
      expect(card.textContent).toContain("report.pdf. Change it in the bar above.")
      expect(within(card).queryByRole("textbox")).toBeNull()
      expect(within(card).queryByRole("combobox")).toBeNull()
    })

    it("says there is none yet", () => {
      const card = renderCard({ node: source, title: "Document", transforms: transformsFor(R, "source") })
      expect(card.textContent).toContain("None yet. Pick one in the bar above.")
    })

    it("names a missing file and says where to pick another", () => {
      const card = renderCard({ node: withFile, title: "Document", transforms: transformsFor(R, "source"), missing: true })
      expect(card.textContent).toContain("report.pdf")
      expect(card.textContent).not.toContain("Change it in the bar above.")
      expect(within(card).getByTestId("missing-file").textContent).toBe("Missing. Pick a document in the bar above.")
    })
  })

  describe("scrolling", () => {
    const scroll = vi.fn()
    beforeEach(() => {
      vi.useFakeTimers()
      scroll.mockReset()
      Element.prototype.scrollIntoView = scroll
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      delete (Element.prototype as Partial<Element>).scrollIntoView
      document.querySelectorAll("[data-scroll-box]").forEach((el) => el.remove())
    })

    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 380, width: 380, height, x: 0, y: top, toJSON() {} })

    function inBox(headTop: number, cardTop = headTop) {
      const box = document.createElement("div")
      box.setAttribute("data-scroll-box", "")
      box.style.overflowY = "auto"
      document.body.appendChild(box)
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this === box) return rect(100, 500)
        return this.tagName === "ARTICLE" ? rect(cardTop, 300) : rect(headTop, 40)
      })
      const props: NodeCardProps = {
        node: chunkNode,
        title: "Chunk",
        transforms: transformsFor(R, "chunk"),
        selected: false,
        busy: false,
        onSelect: vi.fn(),
        onTransform: vi.fn(),
        onConfig: vi.fn(),
        onRun: vi.fn(),
      }
      const view = render(<NodeCard {...props} />, { container: box })
      view.rerender(<NodeCard {...props} selected />)
      act(() => {
        vi.runAllTimers()
      })
    }

    it("scrolls the card's own top into view when it is above the column's scroll box, even with its head stuck", () => {
      // A stuck head reads as on screen; the card's top is what has gone.
      inBox(100, -113)
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
      const target = scroll.mock.contexts[0] as HTMLElement
      expect(target.tagName).toBe("ARTICLE")
      expect(target.className.split(/\s+/)).toContain("scroll-mt-3")
    })

    it("brings the head up when it is below the column's scroll box", () => {
      inBox(580)
      expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" })
      expect((scroll.mock.contexts[0] as HTMLElement).tagName).toBe("HEADER")
    })

    it("leaves the scroll alone when the head is already visible", () => {
      inBox(200)
      expect(scroll).not.toHaveBeenCalled()
    })
  })
})

describe("the card head on a stacked step", () => {
  it("wraps instead of squeezing: the title, the whole id and the chip each keep their width", () => {
    payloads = { head1: chunkRecursive }
    const cleanNode = { ...chunkNode, id: "clean_1" }
    const card = renderCard({ node: cleanNode, title: "Clean", showId: true, onRemove: vi.fn(), result: done("head1", "cached") })
    const header = card.querySelector("header")!
    expect(header.className.split(/\s+/)).toContain("flex-wrap")
    expect(header.className.split(/\s+/)).toContain("scroll-mt-3")
    expect(card.querySelector(".break-all")).toBeNull()
    const id = within(header).getByText("clean_1")
    expect(id.className).toContain("whitespace-nowrap")
    expect(within(header).getByRole("button", { name: "Clean" })).toBeTruthy()
    const chip = within(header).getByTestId("status-chip")
    expect(chip.textContent).toBe("reused from an earlier run")
    const right = chip.parentElement!
    expect(right.className.split(/\s+/)).toContain("ml-auto")
    expect(right.className.split(/\s+/)).not.toContain("shrink-0")
  })
})

describe("a running card keeps its status in view", () => {
  it("the open card's head sticks to the top of the scroll box; a closed card's head does not", () => {
    const open = renderCard({ selected: true })
    const head = open.querySelector("header")!
    const cls = head.className.split(/\s+/)
    expect(cls).toEqual(expect.arrayContaining(["sticky", "top-0", "z-20", "bg-surface-raised"]))
    cleanup()
    const closed = renderCard({ selected: false })
    expect(closed.querySelector("header")!.className.split(/\s+/)).not.toContain("sticky")
  })

  it("the breathing edge rides in the head, so it sticks too", () => {
    const card = renderCard({ selected: true, result: { id: "chunk", status: "running" } })
    expect(card.querySelector("header [data-testid='running-bar']")).not.toBeNull()
  })

  it("the Run button reads Running and is busy only while this card's own step runs", () => {
    const now = startedAgo(4)
    const card = renderCard({ selected: true, busy: true, result: { id: "chunk", status: "running", started_at: now } })
    const run = within(card).getByRole("button", { name: "Running" }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.getAttribute("aria-busy")).toBe("true")
    const line = within(card).getByTestId("run-progress")
    expect(line.textContent).toBe("Running Chunk, 4 s")
    expect(line.closest("footer")).not.toBeNull()
  })

  it("the running card's title line says running and the seconds, and goes back to the name after", () => {
    const now = startedAgo(7)
    const card = renderCard({ busy: true, result: { id: "chunk", status: "running", started_at: now } })
    expect(card.querySelector("h3")!.textContent).toBe("Chunk, running, 7 s")
    // One inline label, so the flex gap never opens before the comma; the ticking seconds stay out of the name.
    const label = within(card).getByTestId("card-title")
    expect(label.textContent).toBe("Chunk, running, 7 s")
    expect(label.querySelector("[aria-hidden]")!.textContent).toBe(", 7 s")
    expect(within(card).queryByTestId("status-chip")).toBeNull()
    cleanup()
    const after = renderCard({ result: done("title1") })
    expect(after.querySelector("h3")!.textContent).toBe("Chunk")
  })

  it("another card's run leaves this Run button reading Run, not busy, and no running line", () => {
    const card = renderCard({ selected: true, busy: true })
    const run = within(card).getByRole("button", { name: "Run" }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.hasAttribute("aria-busy")).toBe(false)
    expect(within(card).queryByTestId("run-progress")).toBeNull()
  })

  it("a stale running result is not this card's run", () => {
    const card = renderCard({ selected: true, stale: true, result: { id: "chunk", status: "running" } })
    expect(within(card).getByRole("button", { name: "Run" })).toBeTruthy()
    expect(within(card).queryByTestId("run-progress")).toBeNull()
  })

  it("when the run finishes the result line also sits right under the button row", async () => {
    payloads = { under1: chunkRecursive }
    const card = renderCard({ selected: true, result: done("under1") })
    const under = await within(card).findByTestId("run-result", {}, { timeout: 4000 })
    expect(under.textContent).toBe("Made 6 chunks. Median 67 tokens, largest 76. 3 overlaps.")
    expect(under.previousElementSibling?.tagName).toBe("FOOTER")
    // One result line at a time: the head's copy is for the closed card.
    expect(within(card).queryByTestId("step-summary")).toBeNull()
  })
})

describe("the stuck head", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.querySelectorAll("[data-scroll-box]").forEach((el) => el.remove())
  })

  function boxed(ui: ReactElement) {
    const box = document.createElement("div")
    box.setAttribute("data-scroll-box", "")
    box.style.overflowY = "auto"
    document.body.appendChild(box)
    return { box, view: render(ui, { container: box }) }
  }

  const props = (over: Partial<NodeCardProps> = {}): NodeCardProps => ({
    node: chunkNode,
    title: "Chunk",
    transforms: transformsFor(R, "chunk"),
    selected: true,
    busy: false,
    onSelect: vi.fn(),
    onTransform: vi.fn(),
    onConfig: vi.fn(),
    onRun: vi.fn(),
    ...over,
  })

  it("shows the hairline once the head has stuck, watching the nearest scrolling box 12 px down", () => {
    let fire: IntersectionObserverCallback = () => {}
    let opts: IntersectionObserverInit | undefined
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback, o?: IntersectionObserverInit) {
          fire = cb
          opts = o
        }
        observe() {}
        disconnect() {}
      },
    )
    const { box } = boxed(<NodeCard {...props()} />)
    expect(opts?.root).toBe(box)
    expect(opts?.rootMargin).toBe("-12px 0px 0px 0px")
    const head = box.querySelector("header")!
    expect(head.className).not.toContain("shadow-[0_1px_0_var(--hairline)]")
    const padBefore = head.className.split(/\s+/).filter((c) => /^p[bt]-/.test(c))
    act(() => {
      fire([{ isIntersecting: false, boundingClientRect: { top: 50 }, rootBounds: { top: 112 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(head.className).toContain("shadow-[0_1px_0_var(--hairline)]")
    // Sticking does not change the head's padding, so nothing under it jumps.
    expect(head.className.split(/\s+/).filter((c) => /^p[bt]-/.test(c))).toEqual(padBefore)
  })

  it("the options' fields clear the head by its measured height", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb
        }
        observe() {
          this.cb([], this as unknown as ResizeObserver)
        }
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const h = this.tagName === "HEADER" ? 74.5 : 40
      return { top: 0, bottom: h, left: 0, right: 380, width: 380, height: h, x: 0, y: 0, toJSON() {} } as DOMRect
    })
    const { box, view } = boxed(<NodeCard {...props()} />)
    const card = box.querySelector("article")!
    expect(card.style.getPropertyValue("--head-h")).toBe("74.5px")
    const options = within(card).getByTestId("step-options").querySelector(".min-h-0 > div")!
    expect(options.className).toContain("[&_*]:scroll-mt-(--head-h)")
    view.rerender(<NodeCard {...props({ selected: false })} />)
    expect(card.style.getPropertyValue("--head-h")).toBe("")
  })

  it("scrolls the result line into view once when a run finishes below the fold", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      payloads = { rev1: chunkRecursive }
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const at = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 380, width: 380, height: h, x: 0, y: top, toJSON() {} }) as DOMRect
        if (this.hasAttribute("data-scroll-box")) return at(100, 500)
        if (this.dataset.testid === "run-result") return at(612, 20)
        return at(200, 40)
      })
      const { box, view } = boxed(<NodeCard {...props({ result: { id: "chunk", status: "running" } })} />)
      view.rerender(<NodeCard {...props({ result: done("rev1") })} />)
      const line = await within(box).findByTestId("run-result", {}, { timeout: 4000 })
      await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
      expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" })
      expect(scroll.mock.contexts[0]).toBe(line)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it("yields to a reader who scrolled the column during the run", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      payloads = { rev3: chunkRecursive }
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const at = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 380, width: 380, height: h, x: 0, y: top, toJSON() {} }) as DOMRect
        if (this.hasAttribute("data-scroll-box")) return at(100, 500)
        if (this.dataset.testid === "run-result") return at(612, 20)
        return at(200, 40)
      })
      const box = document.createElement("div")
      box.setAttribute("data-scroll-box", "")
      box.style.overflowY = "auto"
      let top = 241
      Object.defineProperty(box, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) })
      document.body.appendChild(box)
      const view = render(<NodeCard {...props({ result: { id: "chunk", status: "running" } })} />, { container: box })
      top = 0
      view.rerender(<NodeCard {...props({ result: done("rev3") })} />)
      await within(box).findByTestId("run-result", {}, { timeout: 4000 })
      await new Promise((r) => setTimeout(r, 50))
      expect(scroll).not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it("does not scroll to a result that was already there before any run", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      payloads = { rev2: chunkRecursive }
      const { box } = boxed(<NodeCard {...props({ result: done("rev2") })} />)
      await within(box).findByTestId("run-result", {}, { timeout: 4000 })
      expect(scroll).not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
})

describe("the card body is only fields", () => {
  it("a Chunk card with a stage lesson and a strategy lesson shows neither inline", () => {
    const transforms = transformsFor(R, "chunk").map((t) =>
      t.name === chunkNode.transform ? { ...t, learn: { _strategy: { hint: "Cuts at natural places.", more: ["Paragraphs first."] } } } : t,
    )
    const card = renderCard({ selected: true, transforms, lesson: ["Chunks are small pieces of the document."] })
    expect(card.querySelector("[data-learn]")).toBeNull()
    expect(within(card).queryByText("What is chunking?")).toBeNull()
    expect(within(card).queryByText("Chunks are small pieces of the document.")).toBeNull()
    expect(within(card).queryByText("Cuts at natural places.")).toBeNull()
    expect(within(card).getByRole("button", { name: "About Transform" })).toBeTruthy()
  })
})
