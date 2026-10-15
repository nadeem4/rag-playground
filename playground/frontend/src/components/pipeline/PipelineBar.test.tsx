import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import registryFixture from "@/api/fixtures/registry.json"
import templates from "@/api/fixtures/templates.json"
import type { Registry } from "@/api/types"
import { columnOrder, sampleGraph, type PipelineGraph } from "@/state/graph"
import { readCurrentId, resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"
import { resetWorkingForTests } from "@/state/working"

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

describe("PipelineBar: Start from a template", () => {
  it("replaces the pipeline, says so, and Undo puts the previous one back exactly", async () => {
    const made = savePipeline("Mine", before)!
    setCurrentId(made.saved.id)
    const onLoad = vi.fn()
    render(<Bar onLoad={onLoad} />)

    fireEvent.click(screen.getByRole("button", { name: "Start from a template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Use this pipeline" }))

    const used = onLoad.mock.calls[0][0] as PipelineGraph
    expect(columnOrder(used).find((n) => n.stage === "parse")?.transform).toBe("pdfium")
    expect(readCurrentId()).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText(/Build now holds Text documents with Balanced/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(onLoad.mock.calls[1][0]).toBe(before)
    expect(readCurrentId()).toBe(made.saved.id)
    expect(screen.queryByText(/Build now holds/)).toBeNull()
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
