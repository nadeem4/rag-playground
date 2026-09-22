import { describe, expect, it } from "vitest"

import { ApiError } from "@/api/client"
import type { NodeState } from "@/api/runState"

import { addCleaner, columnOrder, initialGraph } from "./graph"
import { buildRunRequest, foldRun, mergeResults, routeRunError, type Tracked } from "./pipeline"
import { TEST_REGISTRY as R } from "./testRegistry"

describe("buildRunRequest", () => {
  it("a card's Run targets that node only; the server runs its ancestors", () => {
    const g = initialGraph(R)
    expect(buildRunRequest(g, { target: "parse" })).toEqual({ graph: g, targets: ["parse"], force: false })
  })

  it("Run all sends no targets, and Rerun sends force", () => {
    const g = initialGraph(R)
    expect(buildRunRequest(g, {})).toEqual({ graph: g, force: false })
    expect(buildRunRequest(g, { target: "chunk", force: true })).toEqual({ graph: g, targets: ["chunk"], force: true })
  })
})

describe("routeRunError", () => {
  const g = addCleaner(initialGraph(R), R)
  const clean = columnOrder(g)[2]

  it("a 422 lands on the named card, keyed by field path", () => {
    const err = new ApiError(
      422,
      {
        node_id: clean.id,
        errors: [
          { type: "less_than_equal", loc: ["min_page_ratio"], msg: "Input should be less than or equal to 1", input: 3 },
        ],
      },
      "/runs",
    )
    expect(routeRunError(err, g)).toEqual({
      kind: "fields",
      nodeId: clean.id,
      errors: { min_page_ratio: ["Input should be less than or equal to 1"] },
    })
  })

  it("a 400 naming exactly one node lands on that card", () => {
    const err = new ApiError(400, "node 'chunk': missing required input 'doc'", "/runs")
    expect(routeRunError(err, g)).toEqual({ kind: "node", nodeId: "chunk", message: "node 'chunk': missing required input 'doc'" })
  })

  it("any other failure is column level", () => {
    expect(routeRunError(new ApiError(400, "graph has a cycle", "/runs"), g)).toEqual({ kind: "column", message: "graph has a cycle" })
    expect(routeRunError(new TypeError("Failed to fetch"), g)).toEqual({ kind: "column", message: "Failed to fetch" })
  })
})

describe("mergeResults", () => {
  it("keeps results for nodes a run pruned and overwrites the ones it ran", () => {
    const prev: Record<string, NodeState> = {
      chunk: { id: "chunk", status: "done", artifact_id: "c1", duration_ms: 9 },
      parse: { id: "parse", status: "done", artifact_id: "p1" },
    }
    const run: Record<string, NodeState> = {
      parse: { id: "parse", status: "cached", artifact_id: "p1", cache_hit: true },
      chunk: { id: "chunk", status: "pruned" },
    }
    expect(mergeResults(prev, run)).toEqual({
      chunk: prev.chunk,
      parse: run.parse,
    })
  })
})

describe("foldRun keeps the previous result of each card", () => {
  const done = (id: string, artifact_id: string, cache_hit = false): NodeState => ({ id, status: cache_hit ? "cached" : "done", artifact_id, cache_hit })

  it("the first run has no previous; the second remembers the first", () => {
    let t: Tracked = { results: {}, history: {} }
    t = foldRun(t, { chunk: { id: "chunk", status: "running" } })
    expect(t.history.chunk).toBeUndefined()
    t = foldRun(t, { chunk: done("chunk", "a") })
    expect(t.history.chunk).toEqual({ current: "a", previous: undefined })
    t = foldRun(t, { chunk: done("chunk", "b") })
    expect(t.history.chunk).toEqual({ current: "b", previous: "a" })
    // Another card's run leaves this history alone.
    t = foldRun(t, { chunk: t.results.chunk, parse: done("parse", "p") })
    expect(t.history.chunk).toEqual({ current: "b", previous: "a" })
    // A cache hit is a run too: it compares against itself.
    t = foldRun(t, { chunk: done("chunk", "b", true) })
    expect(t.history.chunk).toEqual({ current: "b", previous: "b" })
  })

  it("an unchanged run returns the same object", () => {
    const t: Tracked = { results: {}, history: {} }
    expect(foldRun(t, {})).toBe(t)
  })
})
