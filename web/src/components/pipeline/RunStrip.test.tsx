import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { RunStrip, type StripLine, type StripSegment } from "./RunStrip"

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

  it("the running step breathes like the card edge, still under reduced motion", () => {
    const strip = show(segs("done", "running"))
    expect(bar(strip, "parse").className).toContain("bg-primary")
    expect(bar(strip, "parse").className).toContain("step-running-edge")
    expect(bar(strip, "upload").className).not.toContain("step-running-edge")
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
    const startedAt = Math.floor(Date.now() / 1000) - 3
    const strip = show(segs("done", "running"), { kind: "building", title: "Parse", startedAt })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Building: Parse, 3 s")
  })

  it("while a single card runs, the line says Running", () => {
    const startedAt = Math.floor(Date.now() / 1000) - 2
    const strip = show(segs("done", "done", "running"), { kind: "running", title: "Clean", startedAt })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Running Clean, 2 s")
  })

  it("after a build, the line gives the total time", () => {
    const strip = show(segs("done", "done", "done", "reused", "done"), { kind: "built", totalMs: 3400 })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Built in 3.4 s")
  })

  it("after a failure, the line names the failed step", () => {
    const strip = show(segs("done", "failed"), { kind: "failed", title: "Parse" })
    expect(within(strip).getByTestId("run-line").textContent).toBe("Parse failed")
  })
})
