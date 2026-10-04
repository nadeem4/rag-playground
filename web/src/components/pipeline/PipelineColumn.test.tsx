import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { addCleaner, columnOrder, initialGraph, setTransform } from "@/state/graph"
import { routeRunError } from "@/state/pipeline"
import { TEST_REGISTRY as R } from "@/state/testRegistry"
import { optionNames, optionOf } from "@/components/ui/pickerTesting"

import { PipelineColumn, SWEEPABLE, type PipelineColumnProps } from "./PipelineColumn"

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
    expect(titles).toEqual(["Document", "Parse", "Clean", "Chunk", "Index"])
  })

  it("the Document card is plain: no explain button, no Transform, no Run; Parse keeps all three", () => {
    setup()
    const upload = within(card("source"))
    expect(upload.queryByRole("button", { name: "Explain the Upload step" })).toBeNull()
    expect(upload.queryByText("Transform")).toBeNull()
    expect(upload.queryByRole("button", { name: "Run" })).toBeNull()

    const parse = within(card("parse"))
    expect(parse.getByRole("button", { name: "Explain the Parse step" })).toBeTruthy()
    expect(parse.getByText("Transform")).toBeTruthy()
    expect(parse.getByRole("button", { name: "Run" })).toBeTruthy()
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

  it("shows each card's look by data-look, with no left rule", () => {
    setup({
      results: {
        parse: { id: "parse", status: "cached", artifact_id: "p", cache_hit: true, duration_ms: 1 },
        chunk: { id: "chunk", status: "done", artifact_id: "c", cache_hit: false, duration_ms: 12 },
      },
      stale: new Set(["chunk"]),
    })
    expect(card("parse").dataset.look).toBe("done")
    expect(card("chunk").dataset.look).toBe("stale")
    expect(card("index").dataset.look).toBe("idle")
    expect(document.querySelector("[data-rule]")).toBeNull()
    expect(card("parse").style.borderLeft).toBe("")
    // In normal case, not the meta style.
    expect(within(card("parse")).getByText("reused from an earlier run").className.split(/\s+/)).not.toContain("meta")
    expect(within(card("chunk")).getByText("changed, run again")).toBeTruthy()
  })

  it("names the four looks in words in a one-line legend", () => {
    setup()
    expect(screen.getByTestId("step-legend").textContent).toBe(
      "Grey ring: not run. Half ring: running. Ring with a dot: done, dashed when reused. Amber ring: changed, run again.",
    )
  })

  it("lays the cards out as tiles 12 px apart", () => {
    setup()
    const column = card("parse").parentElement!
    expect(column.className.split(/\s+/)).toEqual(expect.arrayContaining(["gap-3", "bg-surface-elevated"]))
    expect(card("parse").className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-panel", "border", "border-hairline"]))
  })

  it("clicking the selected card's head deselects it", () => {
    const p = setup({ selected: "chunk" })
    fireEvent.click(within(card("chunk")).getByRole("button", { name: "Chunk" }))
    expect(p.onSelect).toHaveBeenCalledWith(null)
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Parse" }))
    expect(p.onSelect).toHaveBeenLastCalledWith("parse")
  })

  it("raises only the selected card", () => {
    setup({ selected: "chunk" })
    const raised = document.querySelectorAll("article.shadow-raised")
    expect(raised).toHaveLength(1)
    expect(raised[0].getAttribute("data-node-id")).toBe("chunk")
    expect(card("parse").className.split(/\s+/)).toContain("bg-surface")
    expect(card("parse").className).not.toContain("shadow-raised")
  })

  it("Sweep is offered on index steps only: retrieve lives in the Ask panel", () => {
    expect(SWEEPABLE).not.toContain("retrieve")
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

  it("Parse, Chunk and Index offer Sweep; Index also offers the dimensions preset", () => {
    const p = setup()
    const sweeps = screen.getAllByRole("button", { name: "Sweep" })
    expect(sweeps.map((b) => b.closest("article")!.getAttribute("data-node-id"))).toEqual(["parse", "chunk", "index"])
    fireEvent.click(sweeps[1])
    expect(p.onSweep).toHaveBeenCalledWith("chunk")
    fireEvent.click(within(card("index")).getByRole("button", { name: "Sweep dimensions" }))
    expect(p.onSweep).toHaveBeenCalledWith("index", "matryoshka")
  })

  it("a stage with one transform shows its name as text, not a one-option picker", () => {
    setup()
    // Parse has only `pdfium` in the test registry. The Document card shows no
    // Transform at all (it is plain: pick or upload a file, nothing else).
    for (const [id, name] of [["parse", "Fast text, pdfium"]]) {
      const shown = within(card(id)).getByLabelText("Transform")
      expect(shown.tagName).toBe("OUTPUT")
      expect(shown.textContent).toBe(name)
    }
    // Chunk has three: the picker stays.
    const picker = within(card("chunk")).getByRole("button", { name: /^Transform/ })
    expect(optionNames(picker)).toHaveLength(3)
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
      const title = () => card("parse").querySelector("h3")!.textContent
      expect(title()).toBe("Parse, running, 12 s")
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(title()).toBe("Parse, running, 15 s")
      rerender(<PipelineColumn {...props} results={{ parse: { id: "parse", status: "done", artifact_id: "p", duration_ms: 15000 } }} />)
      expect(title()).toBe("Parse")
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
      expect(card("chunk").querySelector("h3")!.textContent).toBe("Chunk, running, 0 s")
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

describe("locked transforms", () => {
  it("shows nothing extra on a transform that asks nothing of its upstream", () => {
    setup()
    const chunk = within(card("chunk"))
    expect(optionOf(chunk.getByRole("button", { name: /^Transform/ }), "Recursive (natural breaks)").textContent).not.toMatch(/Falls back|Cannot run/)
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    expect(chunk.queryByRole("status")).toBeNull()
    expect(chunk.queryByRole("alert")).toBeNull()
  })

  it("tags a soft lock in the dropdown and says why, but keeps it selectable and runnable", () => {
    setup({ graph: setTransform(initialGraph(R), "chunk", "markdown_header", R) })
    const chunk = within(card("chunk"))
    expect(chunk.getByRole("status").className).toContain("text-stale")
    expect(chunk.getByRole("status").textContent).toBe(
      "Needs headings from the parse step. pdfium does not find any, so the whole document is treated as one section and cut by size.",
    )
    expect(chunk.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false)
    const option = optionOf(chunk.getByRole("button", { name: /^Transform/ }), "By heading")
    expect(option.textContent).toContain("Falls back")
    expect(option.getAttribute("aria-disabled")).toBe("false")
  })
})
