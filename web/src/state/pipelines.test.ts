import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { initialGraph, setTransform } from "./graph"
import {
  MAX_PIPELINES,
  clearPipelines,
  importPipelines,
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
    const a = savePipeline("  First  ", g())!.saved
    const b = savePipeline("Second", setTransform(g(), "chunk", "token_based", R))!.saved
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

  it("keeps at most the newest twenty, and says which one it dropped", () => {
    for (let i = 1; i <= MAX_PIPELINES; i++) expect(savePipeline(`P${i}`, g())!.dropped).toBeNull()
    expect(savePipeline(`P${MAX_PIPELINES + 1}`, g())!.dropped?.name).toBe("P1")
    const names = readPipelines().map((p) => p.name)
    expect(names).toHaveLength(MAX_PIPELINES)
    expect(names[0]).toBe(`P${MAX_PIPELINES + 1}`)
    expect(names).not.toContain("P1")
  })

  it("updates, renames and deletes by id, and deleting the current one clears the selection", () => {
    const p = savePipeline("Mine", g())!.saved
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

  it("follows another tab's writes, and a save here keeps the other tab's entry (I4)", () => {
    const { result } = renderHook(() => usePipelines())
    act(() => { savePipeline("Here", g()) })
    // Another tab saves a pipeline: it writes storage and the browser fires a storage event here.
    const theirs = { id: "other123", name: "Theirs", graph: g(), savedAt: "2026-09-30T00:00:00Z" }
    const key = "rag-playground:pipelines:v1"
    const value = JSON.stringify([theirs, ...readPipelines()])
    window.localStorage.setItem(key, value)
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: value })) })
    expect(result.current.pipelines.map((p) => p.name)).toEqual(["Theirs", "Here"])
    act(() => { savePipeline("Mine too", g()) })
    expect(result.current.pipelines.map((p) => p.name)).toEqual(["Mine too", "Theirs", "Here"])
  })

  it("re-reads storage before writing, so a stale list here never overwrites another tab", () => {
    savePipeline("Here", g())
    const key = "rag-playground:pipelines:v1"
    const theirs = { id: "other123", name: "Theirs", graph: g(), savedAt: "2026-09-30T00:00:00Z" }
    // No storage event: the in-memory list is stale when this tab saves.
    window.localStorage.setItem(key, JSON.stringify([theirs, ...readPipelines()]))
    savePipeline("Mine too", g())
    expect(JSON.parse(window.localStorage.getItem(key)!).map((p: { name: string }) => p.name)).toEqual(["Mine too", "Theirs", "Here"])
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

describe("importing and clearing for the Library", () => {
  const saved = (id: string, savedAt: string) => ({ id, name: `P ${id}`, graph: g(), savedAt })

  it("merges by id and never duplicates", () => {
    const mine = savePipeline("Mine", g())!.saved
    const r = importPipelines([{ ...mine, name: "Same id from the file" }, saved("n1", "2026-09-01T00:00:00.000Z")])!
    expect(readPipelines().filter((p) => p.id === mine.id).map((p) => p.name)).toEqual(["Mine"])
    expect(r.skipped).toBe(1)
    expect(r.added).toBe(1)
    expect(r.leftOut).toEqual([])
  })

  it("never removes a saved pipeline: 4 kept, the 16 newest of 25 incoming added, the other 9 named", () => {
    // The four already here are older than every incoming one, so a newest-first cut would drop them.
    const mine = Array.from({ length: 4 }, (_, i) => saved(`m${i}`, `2026-01-0${i + 1}T00:00:00.000Z`))
    window.localStorage.setItem("rag-playground:pipelines:v1", JSON.stringify(mine))
    resetPipelinesForTests()
    const incoming = Array.from({ length: 25 }, (_, i) => saved(`n${String(i).padStart(2, "0")}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`))
    const r = importPipelines(incoming)!
    const ids = readPipelines().map((p) => p.id)
    expect(ids).toHaveLength(MAX_PIPELINES)
    for (const m of mine) expect(ids).toContain(m.id)
    expect(r.added).toBe(16)
    // The newest incoming go in; the nine oldest are left out, and named.
    expect(r.leftOut.map((p) => p.id)).toEqual(["n08", "n07", "n06", "n05", "n04", "n03", "n02", "n01", "n00"])
    expect(ids).toContain("n24")
    expect(ids).not.toContain("n08")
  })

  it("adds nothing when the list is already full, and says so", () => {
    const full = Array.from({ length: MAX_PIPELINES }, (_, i) => saved(`m${i}`, "2026-01-01T00:00:00.000Z"))
    window.localStorage.setItem("rag-playground:pipelines:v1", JSON.stringify(full))
    resetPipelinesForTests()
    const r = importPipelines([saved("new", "2026-12-01T00:00:00.000Z")])!
    expect(r.added).toBe(0)
    expect(r.leftOut.map((p) => p.id)).toEqual(["new"])
    expect(readPipelines()).toHaveLength(MAX_PIPELINES)
  })

  it("clears every saved pipeline and the selection", () => {
    savePipeline("One", g())
    clearPipelines()
    expect(readPipelines()).toEqual([])
    expect(readCurrentId()).toBeNull()
  })
})
