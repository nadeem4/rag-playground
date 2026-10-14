import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { graphToConfig } from "./config"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, setConfig, storeGraph } from "./graph"
import { sameGraph } from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"
import { KEPT_KEY, keptOldPipeline, markKeptSeen, OLD_GRAPH_KEY, readWorking, resetWorkingForTests, storeWorking, WORKING_KEY } from "./working"

const DOC = { sha: "b".repeat(64), filename: "notes.pdf" }

beforeEach(() => {
  window.localStorage.clear()
  resetWorkingForTests()
  resetStoredGraphForTests()
})
afterEach(() => vi.restoreAllMocks())

describe("the working pipeline", () => {
  it("an old working graph is converted once and the old key is left alone", () => {
    const old = JSON.stringify(sampleGraph(R, DOC, "Why?"))
    window.localStorage.setItem(OLD_GRAPH_KEY, old)
    const p = readWorking()!
    expect(p.config.index.chunk).toEqual({ use: "recursive_character", chunk_size: 400, chunk_overlap: 80 })
    expect(p.documents).toEqual([DOC])
    expect(p.question.text).toBe("Why?")
    expect(JSON.parse(window.localStorage.getItem(WORKING_KEY)!)).toEqual(p)
    expect(window.localStorage.getItem(OLD_GRAPH_KEY)).toBe(old)
  })

  it("one that cannot be converted is kept and build opens the starter", () => {
    const old = JSON.stringify({ nodes: [{ id: "x", stage: "enrich", transform: "y", config: {} }], edges: [] })
    window.localStorage.setItem(OLD_GRAPH_KEY, old)
    expect(readWorking()).toBeNull()
    expect(readStoredGraph(R)).toBeNull()
    expect(window.localStorage.getItem(OLD_GRAPH_KEY)).toBe(old)
    expect(keptOldPipeline()).toEqual({ problem: expect.stringContaining("enrich"), seen: false })
    markKeptSeen()
    expect(keptOldPipeline()?.seen).toBe(true)
    // Once marked, the old graph is never tried again, and never removed.
    expect(readWorking()).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(KEPT_KEY)!).problem).toContain("enrich")
    expect(window.localStorage.getItem(OLD_GRAPH_KEY)).toBe(old)
  })

  it("a new working pipeline wins over an old graph", () => {
    window.localStorage.setItem(OLD_GRAPH_KEY, JSON.stringify(sampleGraph(R, DOC)))
    const c = graphToConfig(setConfig(sampleGraph(R, DOC), "chunk", { chunk_size: 900, chunk_overlap: 0 }))
    if (!c.ok) throw new Error(c.problem)
    storeWorking(c.pipeline)
    expect(readWorking()!.config.index.chunk.chunk_size).toBe(900)
  })

  it("storeGraph stores the config, and the column comes back the same", () => {
    const g = sampleGraph(R, DOC)
    expect(storeGraph(g)).toBe(true)
    const stored = JSON.parse(window.localStorage.getItem(WORKING_KEY)!)
    expect(stored.config.index.parse.use).toBe("pdfium")
    expect(stored).not.toHaveProperty("nodes")
    expect(sameGraph(readStoredGraph(R)!, g)).toBe(true)
  })

  it("a stored pipeline naming a strategy this server lacks does not open, and is not removed", () => {
    const c = graphToConfig(sampleGraph(R, DOC))
    if (!c.ok) throw new Error(c.problem)
    const p = { ...c.pipeline, config: { ...c.pipeline.config, index: { ...c.pipeline.config.index, chunk: { use: "no_such_chunker" } } } }
    storeWorking(p)
    expect(readStoredGraph(R)).toBeNull()
    expect(readWorking()).toEqual(p)
  })

  it("a graph that is not a column is not stored", () => {
    expect(storeGraph({ nodes: [], edges: [] })).toBe(false)
    expect(window.localStorage.getItem(WORKING_KEY)).toBeNull()
  })

  it("keeps working in memory when storage refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(storeGraph(sampleGraph(R, DOC))).toBe(true)
    expect(readWorking()?.documents).toEqual([DOC])
  })
})
