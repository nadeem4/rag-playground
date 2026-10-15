import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import registryFixture from "@/api/fixtures/registry.json"
import templates from "@/api/fixtures/templates.json"
import type { Registry } from "@/api/types"
import { graphToConfig, sameConfig } from "@/state/config"
import { columnOrder, readStoredGraph, sampleGraph, storeGraph, useStoredGraph, type PipelineGraph } from "@/state/graph"
import { readCurrentId, resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"
import { resetWorkingForTests } from "@/state/working"

const readStored = () => readStoredGraph(registry)!

import { PipelineBar } from "./PipelineBar"

const registry = registryFixture as unknown as Registry
const before = sampleGraph(registry, { sha: "ab".repeat(32), filename: "report.pdf" }, "What is it?")

beforeEach(() => {
  window.localStorage.clear()
  resetWorkingForTests()
  resetPipelinesForTests()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (String(url).endsWith("/api/templates") ? new Response(JSON.stringify(templates)) : new Response("null", { status: 404 }))),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The bar over a graph that follows each load, as Build's does. */
function Bar({ onLoad }: { onLoad: (g: PipelineGraph) => void }) {
  return <PipelineBar graph={before} registry={registry} starter={null} onLoad={onLoad} />
}

/** The bar over the stored working pipeline, as Build's is: a load or an edit stores, and the bar redraws from storage. */
function StoredBar() {
  const graph = useStoredGraph(registry, () => before)
  const editChunk = () =>
    storeGraph({ ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, config: { ...n.config, sentences_per_chunk: 9 } } : n)) })
  return (
    <>
      <PipelineBar graph={graph} registry={registry} starter={null} onLoad={(g) => storeGraph(g)} />
      <button type="button" onClick={editChunk}>
        Edit the chunk step
      </button>
    </>
  )
}

describe("PipelineBar: Start from a template", () => {
  it("drops the Undo line once the pipeline is edited, and keeps the edit", async () => {
    render(<StoredBar />)
    fireEvent.click(screen.getByRole("button", { name: "Start from a template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Use this pipeline" }))
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Edit the chunk step" }))
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(screen.queryByText(/Build now holds/)).toBeNull()
    const chunk = columnOrder(JSON.parse(JSON.stringify(readStored()))).find((n) => n.stage === "chunk")
    expect(chunk?.transform).toBe("sentence_window")
    expect(chunk?.config.sentences_per_chunk).toBe(9)
  })

  it("replaces the pipeline, says so, and Undo puts the previous one back exactly", async () => {
    storeGraph(before)
    const made = savePipeline("Mine", before)!
    setCurrentId(made.saved.id)
    render(<StoredBar />)

    fireEvent.click(screen.getByRole("button", { name: "Start from a template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Use this pipeline" }))

    expect(columnOrder(readStored()).find((n) => n.stage === "parse")?.transform).toBe("pdfium")
    expect(readCurrentId()).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText(/Build now holds Text documents with Balanced/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    const back = graphToConfig(readStored())
    const was = graphToConfig(before)
    expect(back.ok && was.ok && sameConfig(back.pipeline.config, was.pipeline.config)).toBe(true)
    expect(back.ok && was.ok && back.pipeline.documents).toEqual(was.ok ? was.pipeline.documents : null)
    expect(readCurrentId()).toBe(made.saved.id)
    expect(screen.queryByText(/Build now holds/)).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start from a template" }))
  })

  it("Keep my current pipeline leaves it as it was", async () => {
    const onLoad = vi.fn()
    render(<Bar onLoad={onLoad} />)
    fireEvent.click(screen.getByRole("button", { name: "Start from a template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Keep my current pipeline" }))
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("PipelineBar: Take it home", () => {
  it("sits next to Copy as YAML and opens the Take it home sheet", async () => {
    render(<Bar onLoad={() => {}} />)
    const copy = screen.getByRole("button", { name: "Copy as YAML" })
    const home = screen.getByRole("button", { name: "Take it home" })
    expect(copy.closest("div")).toBe(home.closest("div"))

    fireEvent.click(home)

    expect(await screen.findByRole("dialog", { name: "Take this pipeline home" })).toBeTruthy()
  })
})
