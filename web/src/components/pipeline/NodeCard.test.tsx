import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import type { NodeState } from "@/api/runState"
import { initialGraph, transformsFor } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { describeResult, NodeCard, type NodeCardProps } from "./NodeCard"

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

    function inBox(headTop: number) {
      const box = document.createElement("div")
      box.setAttribute("data-scroll-box", "")
      box.style.overflowY = "auto"
      document.body.appendChild(box)
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return this === box ? rect(100, 500) : rect(headTop, 40)
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

    it("brings the selected card's head into view when it is above the column's scroll box", () => {
      inBox(20)
      expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" })
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
