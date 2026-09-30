import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { initialGraph, setTransform } from "./graph"
import {
  MAX_PIPELINES,
  decodePipeline,
  deletePipeline,
  encodePipeline,
  readCurrentId,
  readPipelines,
  renamePipeline,
  resetPipelinesForTests,
  sameGraph,
  savePipeline,
  setCurrentId,
  updatePipeline,
  usePipelines,
} from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"

beforeEach(() => {
  window.localStorage.clear()
  resetPipelinesForTests()
})
afterEach(() => vi.unstubAllGlobals())

const g = () => initialGraph(R)

describe("saved pipelines", () => {
  it("saves under a trimmed name, newest first, and makes it current", () => {
    const a = savePipeline("  First  ", g())!
    const b = savePipeline("Second", setTransform(g(), "chunk", "token_based", R))!
    expect(readPipelines().map((p) => p.name)).toEqual(["Second", "First"])
    expect(a.name).toBe("First")
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{8}$/)
    expect(readCurrentId()).toBe(b.id)
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("token_based")
  })

  it("refuses an empty name and a name over 60 characters", () => {
    expect(savePipeline("   ", g())).toBeNull()
    expect(savePipeline("x".repeat(61), g())).toBeNull()
    expect(readPipelines()).toEqual([])
  })

  it("keeps at most the newest twenty", () => {
    for (let i = 1; i <= MAX_PIPELINES + 1; i++) savePipeline(`P${i}`, g())
    const names = readPipelines().map((p) => p.name)
    expect(names).toHaveLength(MAX_PIPELINES)
    expect(names[0]).toBe(`P${MAX_PIPELINES + 1}`)
    expect(names).not.toContain("P1")
  })

  it("updates, renames and deletes by id, and deleting the current one clears the selection", () => {
    const p = savePipeline("Mine", g())!
    expect(updatePipeline(p.id, setTransform(g(), "chunk", "markdown_header", R))).toBe(true)
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("markdown_header")
    expect(renamePipeline(p.id, "Renamed")).toBe(true)
    expect(renamePipeline(p.id, "")).toBe(false)
    expect(readPipelines()[0].name).toBe("Renamed")
    expect(updatePipeline("nope", g())).toBe(false)
    deletePipeline(p.id)
    expect(readPipelines()).toEqual([])
    expect(readCurrentId()).toBeNull()
  })

  it("survives blocked storage without throwing", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") }, removeItem: () => {} })
    resetPipelinesForTests()
    expect(readPipelines()).toEqual([])
    expect(savePipeline("Mine", g())).toBeNull()
    expect(() => setCurrentId("x")).not.toThrow()
  })

  it("ignores junk in storage", () => {
    window.localStorage.setItem("rag-playground:pipelines:v1", "{not json")
    expect(readPipelines()).toEqual([])
    resetPipelinesForTests()
    window.localStorage.setItem(
      "rag-playground:pipelines:v1",
      JSON.stringify([
        { id: 1, name: null },
        { id: "ok123456", name: "Kept", graph: { nodes: [], edges: [] }, savedAt: "2026-09-30T00:00:00Z" },
      ]),
    )
    expect(readPipelines().map((p) => p.name)).toEqual(["Kept"])
  })

  it("notifies subscribers", () => {
    const { result } = renderHook(() => usePipelines())
    expect(result.current.pipelines).toEqual([])
    act(() => { savePipeline("Live", g()) })
    expect(result.current.pipelines.map((p) => p.name)).toEqual(["Live"])
    expect(result.current.currentId).toBe(result.current.pipelines[0].id)
    act(() => setCurrentId(null))
    expect(result.current.currentId).toBeNull()
  })
})

describe("sameGraph", () => {
  it("compares nodes and edges regardless of order", () => {
    const a = g()
    const b = { nodes: [...a.nodes].reverse(), edges: [...a.edges].reverse() }
    expect(sameGraph(a, b)).toBe(true)
    expect(sameGraph(a, setTransform(a, "chunk", "token_based", R))).toBe(false)
  })
})

describe("the share link codec", () => {
  it("round trips a name and graph through base64url with no padding", () => {
    const graph = setTransform(g(), "chunk", "token_based", R)
    const code = encodePipeline("Token chunks", graph)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePipeline(code, R)).toEqual({ name: "Token chunks", graph })
  })

  it("refuses garbage, a wrong version, and a graph with an unknown transform", () => {
    expect(decodePipeline("not base64url!", R)).toBeNull()
    expect(decodePipeline(btoa(JSON.stringify({ v: 2, name: "x", graph: g() })).replace(/=+$/, ""), R)).toBeNull()
    const foreign = { ...g(), nodes: g().nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) }
    expect(decodePipeline(encodePipeline("x", foreign), R)).toBeNull()
  })

  it("keeps non-ASCII names intact", () => {
    const code = encodePipeline("Résumé étape", g())
    expect(decodePipeline(code, R)?.name).toBe("Résumé étape")
  })
})
