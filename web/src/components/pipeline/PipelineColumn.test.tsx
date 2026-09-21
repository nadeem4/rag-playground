import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { addCleaner, columnOrder, initialGraph } from "@/state/graph"
import { routeRunError } from "@/state/pipeline"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { PipelineColumn, type PipelineColumnProps } from "./PipelineColumn"

beforeEach(() => {
  // The Load card lists uploaded sources on mount.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup(over: Partial<PipelineColumnProps> = {}) {
  const props: PipelineColumnProps = {
    graph: addCleaner(initialGraph(R), R),
    registry: R,
    results: {},
    stale: new Set(),
    selected: null,
    busy: false,
    errors: {},
    onSelect: vi.fn(),
    onTransform: vi.fn(),
    onConfig: vi.fn(),
    onRun: vi.fn(),
    onAddCleaner: vi.fn(),
    onRemove: vi.fn(),
    onSweep: vi.fn(),
    ...over,
  }
  render(<PipelineColumn {...props} />)
  return props
}

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement

describe("PipelineColumn", () => {
  it("titles cards with plain verbs, in graph order", () => {
    setup()
    const titles = [...document.querySelectorAll("article h3")].map((h) => h.textContent)
    expect(titles).toEqual(["Load", "Parse", "Clean", "Chunk"])
  })

  it("Run on a card runs that node", () => {
    const p = setup()
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    expect(p.onRun).toHaveBeenCalledWith("parse", false)
  })

  it("Rerun appears once a card has output, and forces", () => {
    const p = setup({ results: { chunk: { id: "chunk", status: "done", artifact_id: "a", duration_ms: 3 } } })
    fireEvent.click(within(card("chunk")).getByRole("button", { name: "Rerun" }))
    expect(p.onRun).toHaveBeenCalledWith("chunk", true)
  })

  it("encodes computed versus cached as a solid versus dotted left rule", () => {
    setup({
      results: {
        parse: { id: "parse", status: "cached", artifact_id: "p", cache_hit: true, duration_ms: 1 },
        chunk: { id: "chunk", status: "done", artifact_id: "c", cache_hit: false, duration_ms: 12 },
      },
    })
    expect(card("parse").dataset.rule).toBe("dotted")
    expect(card("parse").style.borderLeft).toContain("dotted")
    expect(card("chunk").dataset.rule).toBe("solid")
    expect(card("source").dataset.rule).toBe("none")
  })

  it("a 422 shows under the right field of the right card", () => {
    const graph = addCleaner(initialGraph(R), R)
    const routed = routeRunError(
      new ApiError(422, { node_id: "chunk", errors: [{ loc: ["chunk_size"], msg: "Input should be greater than or equal to 1", type: "x" }] }, "/runs"),
      graph,
    )
    if (routed.kind !== "fields") throw new Error("expected field errors")
    setup({ graph, errors: { [routed.nodeId]: { fields: routed.errors } } })
    const input = within(card("chunk")).getByLabelText("Chunk Size")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    const describedBy = input.getAttribute("aria-describedby")!.split(" ")
    const err = describedBy.map((id) => document.getElementById(id)).find((el) => el?.textContent?.includes("greater than or equal to 1"))
    expect(err).toBeTruthy()
    expect(within(card("parse")).queryByText(/greater than or equal/)).toBeNull()
  })

  it("a failed node shows its error line, with the traceback behind a disclosure", () => {
    const tb = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: chunk_overlap must be smaller than chunk_size'
    setup({ results: { chunk: { id: "chunk", status: "failed", error: tb } } })
    const c = card("chunk")
    expect(within(c).getByText("ValueError: chunk_overlap must be smaller than chunk_size")).toBeTruthy()
    const details = c.querySelector("details")!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain("Traceback (most recent call last)")
  })

  it("Add cleaner and Remove are graph operations passed up", () => {
    const p = setup()
    fireEvent.click(screen.getByRole("button", { name: "Add cleaner" }))
    expect(p.onAddCleaner).toHaveBeenCalled()
    const clean = columnOrder(p.graph).find((n) => n.stage === "clean")!
    fireEvent.click(screen.getByRole("button", { name: `Remove ${clean.id}` }))
    expect(p.onRemove).toHaveBeenCalledWith(clean.id)
  })

  it("only the Chunk card offers Sweep", () => {
    const p = setup()
    const sweeps = screen.getAllByRole("button", { name: "Sweep" })
    expect(sweeps).toHaveLength(1)
    fireEvent.click(sweeps[0])
    expect(p.onSweep).toHaveBeenCalledWith("chunk")
  })
})
