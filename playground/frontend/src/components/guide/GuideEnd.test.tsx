import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GUIDE_RULE, stageNode } from "@/state/guide"
import { sampleGraph } from "@/state/graph"
import {
  FULL_OF_KEPT,
  MAX_PIPELINES,
  OLD_LIST_KEY,
  readCurrentId,
  readPipelines,
  resetPipelinesForTests,
  savePipeline,
} from "@/state/pipelines"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { GuideEnd } from "./GuideEnd"

const DOC = { sha: "a".repeat(64), filename: "primer.pdf" }
const graph = sampleGraph(R, DOC, "What decides chunk size?")

function setup() {
  const props = { graph, rule: GUIDE_RULE, onSaved: vi.fn(), onOwn: vi.fn(), onLeave: vi.fn() }
  return { props, ...render(<GuideEnd {...props} />) }
}

describe("GuideEnd", () => {
  beforeEach(() => {
    cleanup()
    window.localStorage.clear()
    act(() => resetPipelinesForTests())
  })

  it("shows the rule and prefills the name from the graph's chunk size", () => {
    setup()
    expect(screen.getByText(GUIDE_RULE)).toBeTruthy()
    const size = stageNode(graph, "chunk")!.config.chunk_size
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(`Chunks of ${size}`)
  })

  it("saves one pipeline named as typed, selects it and reports it", () => {
    const { props } = setup()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My chunks" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    const list = readPipelines()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("My chunks")
    expect(readCurrentId()).toBe(list[0].id)
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: list[0].id, name: "My chunks" }))
  })

  it("after saving, swaps Save for the two next steps", () => {
    const { props } = setup()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My chunks" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("My chunks is in your Library. Save as at the top of Build does the same later.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.queryByText(/More guided runs/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Try it on your own document" }))
    expect(props.onOwn).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Keep playing here" }))
    expect(props.onLeave).toHaveBeenCalledTimes(1)
  })

  it("asks for a name and stores nothing when the name is empty", () => {
    const { props } = setup()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Give the pipeline a name.")).toBeTruthy()
    expect(readPipelines()).toHaveLength(0)
    expect(props.onSaved).not.toHaveBeenCalled()
  })

  it("says so when the list is full of older pipelines", () => {
    const broken = { nodes: [{ id: "x", stage: "extract", transform: "y", config: {} }], edges: [] }
    const kept = Array.from({ length: MAX_PIPELINES }, (_, i) => ({
      id: `k${String(i).padStart(7, "0")}`,
      name: `Old ${i}`,
      graph: broken,
      documents: [DOC],
      savedAt: "2026-10-01T00:00:00.000Z",
    }))
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify(kept))
    act(() => resetPipelinesForTests())
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText(FULL_OF_KEPT)).toBeTruthy()
  })

  it("says which pipeline was removed when the list was already full", () => {
    for (let i = 0; i < MAX_PIPELINES; i++) savePipeline(`Old ${i}`, graph)
    expect(readPipelines()).toHaveLength(MAX_PIPELINES)
    setup()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Newest" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    const text = screen.getByRole("status").textContent ?? ""
    expect(text).toContain("Newest is in your Library.")
    expect(text).toMatch(/the oldest pipeline, was removed to keep 20/)
  })

  it("moves focus to Try it on your own document after saving", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try it on your own document" }))
  })

  it("uses no dashes in its copy, before or after saving", () => {
    const { container } = setup()
    expect(container.textContent).not.toMatch(/[–—]/)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(container.textContent).not.toMatch(/[–—]/)
  })
})
