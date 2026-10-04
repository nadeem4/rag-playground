import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { addCleaner, columnOrder, INDEX_STAGES, initialGraph } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { RunStrip, stripSegments, type StripLine, type StripSegment } from "./RunStrip"

/** A start time `ago` seconds before a frozen clock, so a slow machine cannot tick the shown seconds over. */
const FROZEN_MS = 1_800_000_000_000
function startedAgo(ago: number): number {
  vi.useFakeTimers({ now: FROZEN_MS, toFake: ["Date"] })
  return FROZEN_MS / 1000 - ago
}
afterEach(() => vi.useRealTimers())


afterEach(cleanup)

const TITLES = ["Upload", "Parse", "Clean", "Chunk", "Index"]

function segs(...states: StripSegment["state"][]): StripSegment[] {
  return TITLES.map((title, i) => ({ id: title.toLowerCase(), title, state: states[i] ?? "todo" }))
}

function show(segments: StripSegment[], line: StripLine = null) {
  render(<RunStrip segments={segments} line={line} />)
  return screen.getByTestId("run-strip")
}

const seg = (strip: HTMLElement, id: string) => strip.querySelector(`[data-segment="${id}"]`) as HTMLElement
const bar = (strip: HTMLElement, id: string) => within(seg(strip, id)).getByTestId("strip-bar")

describe("the run strip", () => {
  it("before anything runs: five hairlines with their labels, in column order, and no line", () => {
    const strip = show(segs())
    const items = within(strip).getAllByRole("listitem")
    expect(items.map((li) => li.textContent)).toEqual(TITLES)
    for (const t of TITLES) expect(bar(strip, t.toLowerCase()).className).toContain("bg-hairline")
    expect(within(strip).queryByTestId("run-line")).toBeNull()
  })

  it("a done step is an accent fill; a reused one has a dashed accent border", () => {
    const strip = show(segs("done", "reused"))
    expect(seg(strip, "upload").dataset.state).toBe("done")
    expect(bar(strip, "upload").className).toContain("bg-primary")
    expect(bar(strip, "parse").className).toContain("border-dashed")
    expect(bar(strip, "parse").className).toContain("border-primary")
  })

  it("the running step breathes like the card edge", () => {
    const strip = show(segs("done", "running"))
    expect(bar(strip, "parse").className).toContain("bg-primary")
    expect(bar(strip, "parse").className).toContain("step-running-edge")
    expect(bar(strip, "upload").className).not.toContain("step-running-edge")
  })

  it("under reduced motion the running step is a still half fill in a hairline outline, unlike a done one", () => {
    const strip = show(segs("done", "running"))
    const running = bar(strip, "parse")
    expect(running.className).toContain("motion-reduce:bg-transparent")
    expect(running.className).toContain("motion-reduce:border-hairline")
    const half = within(running).getByTestId("strip-half")
    expect(half.className).toContain("motion-reduce:block")
    expect(half.className).toContain("w-1/2")
    expect(within(bar(strip, "upload")).queryByTestId("strip-half")).toBeNull()
  })

  it("labels wrap rather than truncate, and the line takes its own row when the bars need it", () => {
    const strip = show(segs("done", "running"), { kind: "building", title: "Parse" })
    for (const li of within(strip).getAllByRole("listitem")) expect(li.innerHTML).not.toContain("truncate")
    expect(strip.className).toContain("flex-wrap")
    expect(within(strip).getByRole("list").style.minWidth).toBe("16.25rem")
  })

  it("each segment says its step and its state to a screen reader", () => {
    const strip = show(segs("done", "reused", "running"))
    expect(within(strip).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      "Upload, done",
      "Parse, reused",
      "Clean, running",
      "Chunk, to go",
      "Index, to go",
    ])
  })

  it("a failed step is a danger fill with failed in its label", () => {
    const strip = show(segs("done", "failed"))
    expect(bar(strip, "parse").className).toContain("bg-danger")
    expect(seg(strip, "parse").textContent).toBe("Parse failed")
  })

  it("a stale step is amber", () => {
    const strip = show(segs("done", "stale"))
    expect(bar(strip, "parse").className).toContain("bg-stale")
  })

  it("while a build runs, the line names the step and its seconds", () => {
    const startedAt = startedAgo(3)
    const strip = show(segs("done", "running"), { kind: "building", title: "Parse", startedAt })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Building: Parse, 3 s")
  })

  it("while a single card runs, the line says Running", () => {
    const startedAt = startedAgo(2)
    const strip = show(segs("done", "done", "running"), { kind: "running", title: "Clean", startedAt })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Running Clean, 2 s")
  })

  it("after a build, the line gives the total time", () => {
    const strip = show(segs("done", "done", "done", "reused", "done"), { kind: "built", totalMs: 3400 })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Built in 3.4 s")
  })

  it("a build that took under a tenth of a second says so", () => {
    const strip = show(segs("reused", "reused", "reused", "reused", "reused"), { kind: "built", totalMs: 30 })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Built in under 0.1 s")
  })

  it("after a failure, the line names the failed step", () => {
    const strip = show(segs("done", "failed"), { kind: "failed", title: "Parse" })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Parse failed")
  })

  it("a run refused before it started says so in the failed style, pointing at the note above the cards", () => {
    const strip = show(segs(), { kind: "refused" })
    const line = within(strip).getByTestId("run-line")
    expect(line.textContent).toBe("Could not start. See the note above the cards.")
    expect(line.className).toContain("text-danger")
  })
})

describe("stripSegments", () => {
  const twoCleaners = () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    return columnOrder(g).filter((n) => INDEX_STAGES.includes(n.stage))
  }

  it("stacked cleaners are told apart by position, so no two segments share a label", () => {
    const titles = stripSegments(twoCleaners(), {}, new Set()).map((s) => s.title)
    expect(titles).toEqual(["Upload", "Parse", "Clean 1", "Clean 2", "Chunk", "Index"])
  })

  it("one cleaner is just Clean", () => {
    const steps = columnOrder(addCleaner(initialGraph(R), R)).filter((n) => INDEX_STAGES.includes(n.stage))
    expect(stripSegments(steps, {}, new Set()).map((s) => s.title)).toEqual(["Upload", "Parse", "Clean", "Chunk", "Index"])
  })

  it("during a run, its steps follow this run only: not reached yet is to go, whatever they showed before", () => {
    const steps = columnOrder(initialGraph(R)).filter((n) => INDEX_STAGES.includes(n.stage))
    const old = Object.fromEntries(steps.map((n) => [n.id, { id: n.id, status: "done" as const, duration_ms: 5 }]))
    const live = {
      ids: new Set(["source", "parse", "chunk"]),
      nodes: { source: { id: "source", status: "cached" as const }, parse: { id: "parse", status: "running" as const }, chunk: { id: "chunk", status: "pending" as const } },
    }
    const states = stripSegments(steps, old, new Set(["index"]), live).map((s) => s.state)
    // Index is outside this run: it keeps its last look (stale).
    expect(states).toEqual(["reused", "running", "todo", "stale"])
  })

  it("a step the run covers but has not reported yet is to go", () => {
    const steps = columnOrder(initialGraph(R)).filter((n) => INDEX_STAGES.includes(n.stage))
    const old = Object.fromEntries(steps.map((n) => [n.id, { id: n.id, status: "cached" as const }]))
    const states = stripSegments(steps, old, new Set(), { ids: new Set(steps.map((n) => n.id)), nodes: {} }).map((s) => s.state)
    expect(states).toEqual(["todo", "todo", "todo", "todo"])
  })

  it("with no run in flight, a step left running is to go, not breathing forever", () => {
    const steps = columnOrder(initialGraph(R)).filter((n) => INDEX_STAGES.includes(n.stage))
    const states = stripSegments(steps, { parse: { id: "parse", status: "running" } }, new Set()).map((s) => s.state)
    expect(states[1]).toBe("todo")
  })
})
