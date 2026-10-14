import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { withDocument } from "./document"
import { initialGraph, sampleGraph, setConfig, setTransform } from "./graph"
import {
  LIST_KEY,
  MAX_PIPELINES,
  OLD_LIST_KEY,
  fromOld,
  FULL_OF_KEPT,
  fullOfKept,
  keptReason,
  usableGraph,
  clearPipelines,
  importPipelines,
  isEdited,
  sameSteps,
  STARTER_ID,
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
    expect(readPipelines()[0].config?.index.chunk.use).toBe("token_based")
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
    expect(readPipelines()[0].config?.index.chunk.use).toBe("markdown_header")
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

  it("ignores junk in the list, and keeps junk in an old list marked rather than drop it", () => {
    window.localStorage.setItem(LIST_KEY, "{not json")
    expect(readPipelines()).toEqual([])
    resetPipelinesForTests()
    const mine = fromOld({ id: "ok123456", name: "Mine", graph: g(), savedAt: "2026-09-30T00:00:00Z" }, 0)
    window.localStorage.setItem(LIST_KEY, JSON.stringify([{ id: 1, name: null }, mine]))
    expect(readPipelines().map((p) => p.name)).toEqual(["Mine"])
    window.localStorage.clear()
    resetPipelinesForTests()
    window.localStorage.setItem(OLD_LIST_KEY, "{not json")
    expect(readPipelines()).toEqual([])
    resetPipelinesForTests()
    window.localStorage.setItem(
      OLD_LIST_KEY,
      JSON.stringify([
        { id: 1, name: null },
        { id: "ok123456", name: "Kept", graph: { nodes: [], edges: [] }, savedAt: "2026-09-30T00:00:00Z" },
      ]),
    )
    expect(readPipelines().map((p) => [p.name, p.config === null])).toEqual([
      ["A pipeline from an older version", true],
      ["Kept", true],
    ])
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
    const theirs = fromOld({ id: "other123", name: "Theirs", graph: g(), savedAt: "2026-09-30T00:00:00Z" }, 0)
    const key = LIST_KEY
    const value = JSON.stringify([theirs, ...readPipelines()])
    window.localStorage.setItem(key, value)
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: value })) })
    expect(result.current.pipelines.map((p) => p.name)).toEqual(["Theirs", "Here"])
    act(() => { savePipeline("Mine too", g()) })
    expect(result.current.pipelines.map((p) => p.name)).toEqual(["Mine too", "Theirs", "Here"])
  })

  it("re-reads storage before writing, so a stale list here never overwrites another tab", () => {
    savePipeline("Here", g())
    const key = LIST_KEY
    const theirs = fromOld({ id: "other123", name: "Theirs", graph: g(), savedAt: "2026-09-30T00:00:00Z" }, 0)
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
    expect(decodePipeline(code, R)).toEqual({ ok: true, name: "Token chunks", graph, documents: [] })
  })

  it("refuses garbage and a wrong version, and says why a graph with an unknown transform cannot open", () => {
    expect(decodePipeline("not base64url!", R)).toBeNull()
    expect(decodePipeline(btoa(JSON.stringify({ v: 3, name: "x", graph: g() })).replace(/=+$/, ""), R)).toBeNull()
    const foreign = { ...g(), nodes: g().nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) }
    expect(decodePipeline(encodePipeline("x", foreign), R)).toEqual({ ok: false, problem: "It uses a step this server does not have: semantic." })
  })

  it("keeps non-ASCII names intact", () => {
    const code = encodePipeline("Résumé étape", g())
    expect(decodePipeline(code, R)).toMatchObject({ ok: true, name: "Résumé étape" })
  })
})

describe("importing and clearing for the Library", () => {
  const saved = (id: string, savedAt: string) => ({ id, name: `P ${id}`, graph: g(), documents: [], savedAt })

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
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify(mine))
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
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify(full))
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

describe("a pipeline owns its documents, as a list", () => {
  const primer = { sha: "a".repeat(64), filename: "chunking-primer.pdf" }
  const table = { sha: "b".repeat(64), filename: "table-of-figures.pdf" }
  const on = (doc: typeof primer) => withDocument(g(), doc)

  it("saves the graph's document as a list of one", () => {
    const p = savePipeline("Mine", on(primer))!.saved
    expect(p.documents).toEqual([primer])
    expect(readPipelines()[0].documents).toEqual([primer])
  })

  it("saves the documents it is given, and opens on the first", () => {
    const p = savePipeline("Mine", on(primer), { documents: [table] })!.saved
    expect(p.documents).toEqual([table])
    expect(usableGraph(p, R)!.nodes.find((n) => n.stage === "source")?.config.sha).toBe(table.sha)
  })

  it("can save without changing which pipeline Build has selected", () => {
    setCurrentId("other123")
    savePipeline("From Evaluate", on(primer), { select: false })
    expect(readCurrentId()).toBe("other123")
  })

  it("migrates old saved data with one document in the graph to a list of one, on read", () => {
    const old = { id: "old12345", name: "Old", graph: on(primer), savedAt: "2026-09-30T00:00:00Z" }
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([old]))
    resetPipelinesForTests()
    expect(readPipelines()[0].documents).toEqual([primer])
  })

  it("trusts the graph's document when a stored list disagrees with it", () => {
    const odd = { id: "odd12345", name: "Odd", graph: on(primer), documents: [table], savedAt: "2026-09-30T00:00:00Z" }
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([odd]))
    resetPipelinesForTests()
    expect(readPipelines()[0].documents).toEqual([primer])
  })

  it("migrates an old pipeline with no document to an empty list", () => {
    const old = { id: "old12345", name: "Old", graph: g(), savedAt: "2026-09-30T00:00:00Z" }
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([old]))
    resetPipelinesForTests()
    expect(readPipelines()[0].documents).toEqual([])
  })

  it("updates the documents with the graph", () => {
    const p = savePipeline("Mine", on(primer))!.saved
    updatePipeline(p.id, on(table))
    expect(readPipelines()[0].documents).toEqual([table])
  })

  it("imports old files without documents as a list of one", () => {
    const r = importPipelines([{ id: "imp12345", name: "Imp", graph: on(primer), savedAt: "2026-09-30T00:00:00Z" } as never])!
    expect(r.added).toBe(1)
    expect(readPipelines()[0].documents).toEqual([primer])
  })

  it("share links carry the documents, and an old link without them still opens", () => {
    const code = encodePipeline("Mine", on(primer))
    expect(decodePipeline(code, R)).toMatchObject({ ok: true, documents: [primer] })
    const v1 = btoa(JSON.stringify({ v: 1, name: "Old link", graph: on(table) })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
    expect(decodePipeline(v1, R)).toMatchObject({ name: "Old link", documents: [table] })
  })
})

describe("sameSteps and isEdited", () => {
  const primer = { sha: "a".repeat(64), filename: "chunking-primer.pdf" }
  const table = { sha: "b".repeat(64), filename: "table-of-figures.pdf" }
  const query = (graph: ReturnType<typeof g>) => graph.nodes.find((n) => n.stage === "query")!.id

  it("ignores the document and the question, not the steps", () => {
    const a = withDocument(g(), primer)
    expect(sameSteps(a, withDocument(g(), table))).toBe(true)
    expect(sameSteps(a, setConfig(a, query(a), { text: "Another question?" }))).toBe(true)
    expect(sameSteps(a, setTransform(a, "chunk", "token_based", R))).toBe(false)
  })

  it("a saved pipeline is edited by a step or by another document; the Starter only by a step", () => {
    const graph = withDocument(g(), primer)
    const config = fromOld({ graph }, 0).config
    const saved = { id: "mine1234", config, documents: [primer] }
    const starter = { id: STARTER_ID, config, documents: [primer] }
    expect(isEdited(saved, graph)).toBe(false)
    expect(isEdited(saved, withDocument(graph, table))).toBe(true)
    expect(isEdited(starter, withDocument(graph, table))).toBe(false)
    expect(isEdited(starter, setTransform(graph, "chunk", "token_based", R))).toBe(true)
  })
})

const DOC = { sha: "e".repeat(64), filename: "old.pdf" }
const oldItem = (id: string, graph: unknown, savedAt = "2026-10-01T00:00:00.000Z") => ({ id, name: `Old ${id}`, graph, documents: [DOC], savedAt })
const BROKEN = { nodes: [{ id: "x", stage: "enrich", transform: "y", config: {} }], edges: [] }

describe("the Library list as configs", () => {
  it("converts an old list once into the new key and leaves the old key alone", () => {
    const old = JSON.stringify([oldItem("aaaaaaaa", sampleGraph(R, DOC))])
    window.localStorage.setItem(OLD_LIST_KEY, old)
    const [p] = readPipelines()
    expect(p.config?.index.chunk).toEqual({ use: "recursive_character", chunk_size: 400, chunk_overlap: 80 })
    expect(p.documents).toEqual([DOC])
    expect(p.kept).toBeUndefined()
    expect(JSON.parse(window.localStorage.getItem(LIST_KEY)!)[0].config.index.parse.use).toBe("pdfium")
    expect(window.localStorage.getItem(OLD_LIST_KEY)).toBe(old)
  })

  it("keeps an item it cannot convert, marked, listed and never opened", () => {
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([oldItem("bbbbbbbb", BROKEN), "not even an object"]))
    const list = readPipelines()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: "bbbbbbbb", config: null, kept: { graph: BROKEN, problem: expect.stringContaining("enrich") } })
    expect(list[1]).toMatchObject({ name: "A pipeline from an older version", config: null, kept: { graph: "not even an object" } })
    expect(usableGraph(list[0], R)).toBeNull()
    // Saving another pipeline and reading again keeps both.
    savePipeline("New", g())
    resetPipelinesForTests()
    expect(readPipelines().filter((p) => p.kept)).toHaveLength(2)
  })

  it("never drops a kept item to make room", () => {
    const kept = Array.from({ length: MAX_PIPELINES - 1 }, (_, i) => oldItem(`k${String(i).padStart(7, "0")}`, BROKEN, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`))
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([...kept, oldItem("oldest00", sampleGraph(R, DOC), "2025-01-01T00:00:00.000Z")]))
    expect(readPipelines()).toHaveLength(MAX_PIPELINES)
    expect(savePipeline("Newest", g())!.dropped?.id).toBe("oldest00")
    expect(savePipeline("One more", g())!.dropped?.name).toBe("Newest")
    expect(readPipelines().filter((p) => p.kept)).toHaveLength(MAX_PIPELINES - 1)
  })

  it("refuses a save rather than drop a kept item when every other item is kept", () => {
    const kept = Array.from({ length: MAX_PIPELINES }, (_, i) => oldItem(`k${String(i).padStart(7, "0")}`, BROKEN))
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify(kept))
    expect(savePipeline("New", g())).toBeNull()
    expect(readPipelines()).toHaveLength(MAX_PIPELINES)
  })

  it("saves a config, never a graph", () => {
    savePipeline("Mine", g())
    const stored = JSON.parse(window.localStorage.getItem(LIST_KEY)!)[0]
    expect(stored.config.index.parse.use).toBe("pdfium")
    expect(stored).not.toHaveProperty("graph")
  })

  it("fromOld keeps the old documents list only when it agrees with the graph's document", () => {
    const other = { sha: "f".repeat(64), filename: "other.pdf" }
    expect(fromOld({ ...oldItem("cccccccc", sampleGraph(R, DOC)), documents: [other] }, 0).documents).toEqual([DOC])
  })
})

describe("fix round 1", () => {
  it("converts once: a later change to the old list is not read again", () => {
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([oldItem("aaaaaaaa", sampleGraph(R, DOC))]))
    readPipelines()
    const v2 = window.localStorage.getItem(LIST_KEY)
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([oldItem("zzzzzzzz", BROKEN), oldItem("yyyyyyyy", BROKEN)]))
    resetPipelinesForTests()
    expect(readPipelines().map((p) => p.id)).toEqual(["aaaaaaaa"])
    expect(window.localStorage.getItem(LIST_KEY)).toBe(v2)
  })

  it("Delete on the privacy page removes the old list too, and nothing converts again", () => {
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify([oldItem("aaaaaaaa", sampleGraph(R, DOC)), oldItem("bbbbbbbb", BROKEN)]))
    expect(readPipelines()).toHaveLength(2)
    clearPipelines()
    expect(window.localStorage.getItem(OLD_LIST_KEY)).toBeNull()
    expect(window.localStorage.getItem(LIST_KEY)).toBe("[]")
    resetPipelinesForTests()
    expect(readPipelines()).toEqual([])
  })

  it("gives an old item without an id a random one, so two imports do not collide", () => {
    const a = fromOld({ name: "No id", graph: BROKEN }, 0)
    const b = fromOld({ name: "No id", graph: BROKEN }, 0)
    expect(a.id).toMatch(/^kept-1-[A-Za-z0-9_-]{8}$/)
    expect(a.id).not.toBe(b.id)
  })

  it("says why a save is refused when the list is full of kept items", () => {
    expect(fullOfKept()).toBe(false)
    const kept = Array.from({ length: MAX_PIPELINES }, (_, i) => oldItem(`k${String(i).padStart(7, "0")}`, BROKEN))
    window.localStorage.setItem(OLD_LIST_KEY, JSON.stringify(kept))
    expect(savePipeline("New", g())).toBeNull()
    expect(fullOfKept()).toBe(true)
    expect(FULL_OF_KEPT).toBe("The list is full of older pipelines that could not be converted. Delete one in the Library to save this.")
  })

  it("names a kept item's own problem as the reason it cannot be opened", () => {
    expect(keptReason("It has an enrich step.")).toBe("Saved by an older version, and it cannot be opened here: It has an enrich step.")
    expect(keptReason(undefined)).toBe("This server does not have every step this pipeline uses.")
  })
})

const b64 = (o: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

describe("share links", () => {
  it("a new link carries the config, the documents and the question, never a graph", () => {
    const code = encodePipeline("Mine", sampleGraph(R, DOC, "Why?"))
    const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))))
    expect(body).toMatchObject({ v: 3, name: "Mine", documents: [DOC], question: { text: "Why?" } })
    expect(body.config.index.parse.use).toBe("pdfium")
    expect(body).not.toHaveProperty("graph")
    const d = decodePipeline(code, R)
    expect(d?.ok && sameGraph(d.graph, sampleGraph(R, DOC, "Why?"))).toBe(true)
  })

  it.each([1, 2])("an old version %i link still opens", (v) => {
    const d = decodePipeline(b64({ v, name: "Old", graph: sampleGraph(R, DOC), ...(v === 2 ? { documents: [DOC] } : {}) }), R)
    expect(d).toMatchObject({ ok: true, name: "Old", documents: [DOC] })
  })

  it("an old link that cannot be converted says why", () => {
    const d = decodePipeline(b64({ v: 2, name: "Odd", graph: BROKEN, documents: [] }), R)
    expect(d).toEqual({ ok: false, problem: expect.stringContaining("enrich") })
  })

  it("a link from a server with other strategies says so", () => {
    const g = sampleGraph(R, DOC)
    const code = encodePipeline("Elsewhere", g)
    const other = { ...R, parse: {} }
    expect(decodePipeline(code, other)).toEqual({ ok: false, problem: expect.stringContaining("this server") })
  })

  it("something that is not a link at all is null", () => {
    expect(decodePipeline("%%%", R)).toBeNull()
    expect(decodePipeline(b64({ v: 9, name: "x" }), R)).toBeNull()
  })
})
