import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { addCleaner, addReranker, columnOrder, initialGraph } from "@/state/graph"
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
    onAddReranker: vi.fn(),
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
    expect(titles).toEqual(["Load", "Parse", "Clean", "Chunk", "Index", "Ask", "Retrieve", "Search"])
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

  it("Parse, Chunk, Index and Retrieve offer Sweep; Index also offers the dimensions preset", () => {
    const p = setup()
    const sweeps = screen.getAllByRole("button", { name: "Sweep" })
    expect(sweeps.map((b) => b.closest("article")!.getAttribute("data-node-id"))).toEqual(["parse", "chunk", "index", "retrieve"])
    fireEvent.click(sweeps[1])
    expect(p.onSweep).toHaveBeenCalledWith("chunk")
    fireEvent.click(within(card("index")).getByRole("button", { name: "Sweep dimensions" }))
    expect(p.onSweep).toHaveBeenCalledWith("index", "matryoshka")
  })

  it("Add reranker sits after Retrieve; a reranker card is removable and shows its id", () => {
    const p = setup()
    const add = screen.getByRole("button", { name: "Add reranker" })
    expect(add.parentElement!.previousElementSibling!.getAttribute("data-node-id")).toBe("retrieve")
    fireEvent.click(add)
    expect(p.onAddReranker).toHaveBeenCalled()
    cleanup()
    const graph = addReranker(initialGraph(R), R)
    const rr = graph.nodes.find((n) => n.stage === "rerank")!
    const q = setup({ graph })
    expect(within(card(rr.id)).getByText(rr.id)).toBeTruthy()
    fireEvent.click(within(card(rr.id)).getByRole("button", { name: `Remove ${rr.id}` }))
    expect(q.onRemove).toHaveBeenCalledWith(rr.id)
    // Add reranker now follows the last reranker.
    expect(screen.getByRole("button", { name: "Add reranker" }).parentElement!.previousElementSibling!.getAttribute("data-node-id")).toBe(rr.id)
    // Retrieve, Index and Search are not removable.
    for (const id of ["retrieve", "index", "use_case", "query"]) expect(within(card(id)).queryByRole("button", { name: /^Remove/ })).toBeNull()
  })

  it("the Ask card edits the question, and its Run runs through Search", () => {
    const p = setup()
    const box = within(card("query")).getByLabelText("Question")
    expect(box.tagName).toBe("TEXTAREA")
    fireEvent.change(box, { target: { value: "What does overlap cost?" } })
    expect(p.onConfig).toHaveBeenCalledWith("query", { text: "What does overlap cost?" })
    fireEvent.click(within(card("query")).getByRole("button", { name: "Run" }))
    expect(p.onRun).toHaveBeenCalledWith("use_case", false)
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })
    expect(p.onRun).toHaveBeenCalledTimes(2)
    // A plain Enter is a newline, not a run.
    fireEvent.keyDown(box, { key: "Enter" })
    expect(p.onRun).toHaveBeenCalledTimes(2)
  })

  it("a stage with one transform shows its name as text, not a one-option picker", () => {
    setup()
    // Load has only `upload` and Parse only `pdfium` in the test registry.
    for (const [id, name] of [["source", "upload"], ["parse", "pdfium"]]) {
      const shown = within(card(id)).getByLabelText("Transform")
      expect(shown.tagName).toBe("OUTPUT")
      expect(shown.textContent).toBe(name)
    }
    // Chunk has three: the picker stays.
    const picker = within(card("chunk")).getByRole("combobox", { name: "Transform" }) as HTMLSelectElement
    expect(picker.options).toHaveLength(3)
  })

  describe("elapsed time while running", () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(1_000_000_000))
    })
    afterEach(() => vi.useRealTimers())

    it("counts seconds from node_started, once a second, and stops when done", () => {
      const started = 1_000_000_000 / 1000 - 12
      const graph = initialGraph(R)
      const props = {
        graph,
        registry: R,
        stale: new Set<string>(),
        selected: null,
        busy: true,
        errors: {},
        onSelect: vi.fn(),
        onTransform: vi.fn(),
        onConfig: vi.fn(),
        onRun: vi.fn(),
        onAddCleaner: vi.fn(),
        onRemove: vi.fn(),
        onSweep: vi.fn(),
      }
      const { rerender } = render(<PipelineColumn {...props} results={{ parse: { id: "parse", status: "running", started_at: started } }} />)
      expect(within(card("parse")).getByText("running")).toBeTruthy()
      expect(within(card("parse")).getByText("12 s")).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(within(card("parse")).getByText("15 s")).toBeTruthy()
      rerender(<PipelineColumn {...props} results={{ parse: { id: "parse", status: "done", artifact_id: "p", duration_ms: 15000 } }} />)
      expect(within(card("parse")).queryByText("running")).toBeNull()
      expect(within(card("parse")).queryByText("15 s")).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("clears its interval on unmount", () => {
      const graph = initialGraph(R)
      const { unmount } = render(
        <PipelineColumn
          graph={graph}
          registry={R}
          results={{ chunk: { id: "chunk", status: "running", started_at: 1_000_000_000 / 1000 } }}
          stale={new Set()}
          selected={null}
          busy
          errors={{}}
          onSelect={vi.fn()}
          onTransform={vi.fn()}
          onConfig={vi.fn()}
          onRun={vi.fn()}
          onAddCleaner={vi.fn()}
          onRemove={vi.fn()}
          onSweep={vi.fn()}
        />,
      )
      expect(within(card("chunk")).getByText("0 s")).toBeTruthy()
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
