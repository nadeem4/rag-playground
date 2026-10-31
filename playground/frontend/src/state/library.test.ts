import { describe, expect, it } from "vitest"

import type { SampleCard, Source } from "@/api/types"

import { initialGraph, sampleGraph } from "./graph"
import {
  SOON_HOURS,
  base64ToBytes,
  buildExport,
  bytesToBase64,
  docState,
  experimentSummary,
  itemDocState,
  soonHoursOf,
  exportFileName,
  importResultLine,
  libraryItems,
  parseImport,
  keptLine,
  pipelineSummary,
  uploadsOf,
  VERSION,
} from "./library"
import type { SavedExperiment } from "./libraryExperiments"
import { fromOld, usableGraph, type SavedPipeline } from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"

const UP = "ab".repeat(32)
const SAMPLE = "cd".repeat(32)
const NOW = Date.parse("2026-10-04T12:00:00Z")

const pipeline = (id: string, savedAt: string, sha = UP): SavedPipeline => {
  const g = initialGraph(R)
  return fromOld(
    {
      id,
      name: `Pipeline ${id}`,
      savedAt,
      graph: { ...g, nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, config: { ...n.config, sha, filename: "notes.pdf" } } : n)) },
      documents: [{ sha, filename: "notes.pdf" }],
    },
    0,
  )
}

const experiment = (id: string, savedAt: string, doc: SavedExperiment["doc"] = { sha: SAMPLE, filename: "primer.pdf" }): SavedExperiment => ({
  id,
  name: `Experiment ${id}`,
  stage: "chunk",
  recipes: [
    { transform: "recursive_character", config: {} },
    { transform: "token_based", config: {} },
  ],
  doc,
  savedAt,
})

const source = (sha: string, uploaded_at?: string): Source & { uploaded_at?: string } => ({
  sha,
  filename: "notes.pdf",
  size: 1_200_000,
  content_type: "application/pdf",
  ...(uploaded_at ? { uploaded_at } : {}),
})
const samples = [{ sha: SAMPLE, filename: "primer.pdf" }] as SampleCard[]

describe("the library list", () => {
  it("puts pipelines and experiments in one list, newest first", () => {
    const items = libraryItems([pipeline("p1", "2026-10-01T00:00:00Z")], [experiment("e1", "2026-10-02T00:00:00Z")])
    expect(items.map((i) => [i.kind, i.id])).toEqual([["experiment", "e1"], ["pipeline", "p1"]])
    expect(items[1].documents).toEqual([{ sha: UP, filename: "notes.pdf" }])
    expect(items[0].documents).toEqual([{ sha: SAMPLE, filename: "primer.pdf" }])
  })

  it("sums up a pipeline by its steps and an experiment by its step and recipe count", () => {
    expect(pipelineSummary(usableGraph(pipeline("p", "2026-10-01T00:00:00Z"), R))).toMatch(/^[^,]+(, [^,]+)+$/)
    expect(pipelineSummary(null)).toBe("")
    expect(experimentSummary(experiment("e", "x"))).toBe("Chunk, 2 recipes")
    expect(experimentSummary({ ...experiment("e", "x"), recipes: [{ transform: "a", config: {} }] })).toBe("Chunk, 1 recipe")
  })
})

describe("the document state", () => {
  const ctx = { demo: true, ttlHours: 24, now: NOW, samples }

  it("says a sample is always there", () => {
    expect(docState({ sha: SAMPLE, filename: "primer.pdf" }, { ...ctx, sources: [] })).toEqual({ kind: "sample" })
  })

  it("counts an upload's hours left on the demo from its upload time", () => {
    const s = [source(UP, "2026-10-04T00:00:00+00:00")]
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, sources: s })).toEqual({ kind: "upload", hoursLeft: 12 })
    const late = [source(UP, "2026-10-03T14:30:00+00:00")]
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, sources: late })).toEqual({ kind: "upload", hoursLeft: 3 })
    expect(3).toBeLessThan(SOON_HOURS)
  })

  it("says an upload that is not listed is gone, and waits while the list is loading", () => {
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, sources: [] })).toEqual({ kind: "gone" })
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, sources: null })).toEqual({ kind: "checking" })
    expect(docState(null, { ...ctx, sources: [] })).toEqual({ kind: "none" })
  })

  it("says an upload is on this machine when running locally", () => {
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, demo: false, sources: [source(UP)] })).toEqual({ kind: "local" })
    expect(docState({ sha: UP, filename: "notes.pdf" }, { ...ctx, demo: false, sources: [] })).toEqual({ kind: "gone" })
  })

  it("lists each upload the items use once, never a sample", () => {
    const items = libraryItems(
      [pipeline("p1", "2026-10-01T00:00:00Z"), pipeline("p2", "2026-10-01T00:00:00Z")],
      [experiment("e1", "2026-10-02T00:00:00Z")],
    )
    expect(uploadsOf(items, samples)).toEqual([{ sha: UP, filename: "notes.pdf" }])
  })

  const OTHER = "ef".repeat(32)
  const two = (): SavedPipeline => ({ ...pipeline("p2", "2026-10-01T00:00:00Z"), documents: [{ sha: UP, filename: "notes.pdf" }, { sha: OTHER, filename: "second.pdf" }] })

  it("lists every upload of an item with several documents, a pipeline's and an experiment's", () => {
    const e = { ...experiment("e2", "2026-10-02T00:00:00Z"), docs: [{ sha: SAMPLE, filename: "primer.pdf" }, { sha: OTHER, filename: "second.pdf" }] }
    expect(uploadsOf(libraryItems([two()], []), samples)).toEqual([{ sha: UP, filename: "notes.pdf" }, { sha: OTHER, filename: "second.pdf" }])
    expect(uploadsOf(libraryItems([], [e]), samples)).toEqual([{ sha: OTHER, filename: "second.pdf" }])
  })

  it("flags an item when any of its documents is gone or leaving soon, naming that document", () => {
    const [item] = libraryItems([two()], [])
    const fresh = "2026-10-04T11:00:00+00:00"
    const gone = itemDocState(item.documents, { ...ctx, sources: [source(UP, fresh)] })
    expect(gone).toEqual({ doc: { sha: OTHER, filename: "second.pdf" }, state: { kind: "gone" } })
    const soon = itemDocState(item.documents, { ...ctx, sources: [source(UP, fresh), source(OTHER, "2026-10-03T14:30:00+00:00")] })
    expect(soon).toEqual({ doc: { sha: OTHER, filename: "second.pdf" }, state: { kind: "upload", hoursLeft: 3 } })
    const fine = itemDocState(item.documents, { ...ctx, sources: [source(UP, fresh), source(OTHER, fresh)] })
    expect(fine).toEqual({ doc: { sha: UP, filename: "notes.pdf" }, state: { kind: "upload", hoursLeft: 23 } })
  })

  it("with nothing gone or soon, speaks for the upload with the fewest hours left, not a sample before it", () => {
    const docs = [{ sha: SAMPLE, filename: "primer.pdf" }, { sha: UP, filename: "notes.pdf" }]
    const got = itemDocState(docs, { ...ctx, sources: [source(UP, "2026-10-04T08:00:00+00:00")] })
    expect(got).toEqual({ doc: { sha: UP, filename: "notes.pdf" }, state: { kind: "upload", hoursLeft: 20 } })
  })

  it("counts the hours left of every document leaving soon, even when another is gone", () => {
    const docs = [{ sha: OTHER, filename: "second.pdf" }, { sha: UP, filename: "notes.pdf" }]
    const sources = [source(UP, "2026-10-03T14:00:00+00:00")]
    expect(itemDocState(docs, { ...ctx, sources }).state).toEqual({ kind: "gone" })
    expect(soonHoursOf(docs, { ...ctx, sources })).toBe(2)
    expect(soonHoursOf(docs, { ...ctx, sources: [source(UP, "2026-10-04T11:00:00+00:00")] })).toBeNull()
  })

  it("with one document, the item's state is that document's state", () => {
    const one = { sha: UP, filename: "notes.pdf" }
    for (const sources of [[], null, [source(UP, "2026-10-04T00:00:00+00:00")], [source(UP, "2026-10-03T14:30:00+00:00")]]) {
      expect(itemDocState([one], { ...ctx, sources })).toEqual({ doc: one, state: docState(one, { ...ctx, sources }) })
    }
    expect(itemDocState([], { ...ctx, sources: [] })).toEqual({ doc: null, state: { kind: "none" } })
  })
})

describe("export and import", () => {
  it("names the file after one item, or the date for several", () => {
    const items = libraryItems([pipeline("p1", "2026-10-01T00:00:00Z")], [experiment("e1", "2026-10-02T00:00:00Z")])
    expect(exportFileName([items[1]], NOW)).toBe("rag-playground-pipeline-p1.ragplayground.json")
    expect(exportFileName(items, NOW)).toBe("rag-playground-library-2026-10-04.ragplayground.json")
  })

  it("writes the agreed shape and reads it back", () => {
    const items = libraryItems([pipeline("p1", "2026-10-01T00:00:00Z")], [experiment("e1", "2026-10-02T00:00:00Z")])
    const docs = [{ sha: UP, filename: "notes.pdf", pdfBase64: bytesToBase64(new Uint8Array([37, 80, 68, 70])) }]
    const file = buildExport(items, docs, NOW)
    expect(file.format).toBe("rag-playground-library")
    expect(file.version).toBe(2)
    expect(file.exportedAt).toBe("2026-10-04T12:00:00.000Z")
    expect(file.items.map((i) => i.kind)).toEqual(["experiment", "pipeline"])
    const back = parseImport(JSON.stringify(file))
    if (!back.ok) throw new Error(back.error)
    expect(back.pipelines.map((p) => p.id)).toEqual(["p1"])
    expect(back.pipelines[0].config).toEqual(items[1].kind === "pipeline" ? items[1].pipeline.config : null)
    expect(back.experiments.map((e) => e.id)).toEqual(["e1"])
    expect(Array.from(base64ToBytes(back.documents[0].pdfBase64))).toEqual([37, 80, 68, 70])
  })

  it("exports a kept item as it was, with its reason, and reads it back kept", () => {
    const kept = fromOld({ id: "keptkept", name: "From last year", graph: { nodes: [], edges: [] }, savedAt: "2026-01-01T00:00:00Z" }, 0)
    expect(keptLine(kept)).toMatch(/^Saved by an older version\. It cannot be opened here: .+ It is kept in this browser, and Export keeps a copy\.$/)
    const back = parseImport(JSON.stringify(buildExport(libraryItems([kept], []), [], NOW)))
    if (!back.ok) throw new Error(back.error)
    expect(back.pipelines).toEqual([kept])
    expect(keptLine(back.pipelines[0])).toBe(keptLine(kept))
  })

  it("carries each pipeline's documents, and reads an older file's pipeline as a list of one", () => {
    const file = buildExport(libraryItems([pipeline("p1", "2026-10-01T00:00:00Z")], []), [], NOW)
    expect((file.items[0] as SavedPipeline).documents).toEqual([{ sha: UP, filename: "notes.pdf" }])
    // A file an older version made holds a graph, and its document only in the graph's source node.
    const g = initialGraph(R)
    const graph = { ...g, nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, config: { sha: UP, filename: "notes.pdf" } } : n)) }
    const old = { kind: "pipeline", id: "p1", name: "Old", savedAt: "2026-10-01T00:00:00Z", graph }
    const back = parseImport(JSON.stringify({ ...file, version: 1, items: [old] }))
    if (!back.ok) throw new Error(back.error)
    expect(back.pipelines[0].documents).toEqual([{ sha: UP, filename: "notes.pdf" }])
  })

  it("lists a pipeline with every one of its documents", () => {
    const [item] = libraryItems([pipeline("p1", "2026-10-01T00:00:00Z")], [])
    expect(item.documents).toEqual([{ sha: UP, filename: "notes.pdf" }])
  })

  it("refuses a file that is not a library export, in plain words", () => {
    expect(parseImport("not json")).toEqual({ ok: false, error: "This is not a RAG Playground file. Export from Library makes one." })
    expect(parseImport(JSON.stringify({ format: "other" })).ok).toBe(false)
    expect(parseImport(JSON.stringify({ format: "rag-playground-library", version: 3, items: [] }))).toEqual({
      ok: false,
      error: "This file was made by a newer RAG Playground. Update this copy to import it.",
    })
  })

  it("skips items and documents it cannot read, and an experiment with more than ten recipes", () => {
    const tooMany = { ...experiment("big", "2026-10-02T00:00:00Z"), kind: "experiment", recipes: Array.from({ length: 11 }, () => ({ transform: "t", config: {} })) }
    const r = parseImport(
      JSON.stringify({
        format: "rag-playground-library",
        version: 2,
        items: [{ kind: "pipeline", id: 1 }, { kind: "what" }, null, tooMany],
        documents: [{ sha: "x" }, null],
      }),
    )
    expect(r).toEqual({ ok: true, pipelines: [], experiments: [], documents: [], skipped: 4 })
  })

  it("keeps an incoming experiment's own fields, without its kind", () => {
    const raw = { kind: "experiment", ...experiment("e1", "2026-10-02T00:00:00Z"), question: "Who?" }
    const r = parseImport(JSON.stringify({ format: "rag-playground-library", version: 1, items: [raw] }))
    if (!r.ok) throw new Error(r.error)
    const { kind: _kind, ...rest } = raw
    expect(r.experiments).toEqual([rest])
  })

  const none = { fileName: "f.json", pipelines: 0, experiments: 0, already: 0, leftOutPipelines: [], leftOutExperiments: [], unreadable: 0, restored: [], refused: [], damaged: [], mismatched: [] }

  it("says what came in, in one plain line", () => {
    expect(importResultLine({ ...none, fileName: "file.json", pipelines: 2, experiments: 1 })).toBe("Imported 2 pipelines and 1 experiment from file.json.")
    expect(importResultLine({ ...none, already: 3 })).toBe("Nothing new in f.json. You already have all 3 items in it.")
    expect(importResultLine(none)).toBe("f.json has no saved items in it.")
    expect(
      importResultLine({
        ...none,
        pipelines: 1,
        already: 1,
        restored: ["notes.pdf"],
        refused: [{ filename: "big.pdf", reason: "The demo is full right now." }],
      }),
    ).toBe("Imported 1 pipeline from f.json. 1 item was already here. notes.pdf is back on the server. big.pdf was not uploaded: The demo is full right now.")
  })

  it("names what was left out by each kind's own cap, and never says anything saved was removed", () => {
    const line = importResultLine({ ...none, pipelines: 16, experiments: 1, leftOutPipelines: ["A", "B"], leftOutExperiments: ["C"] })
    expect(line).toBe(
      "Imported 16 pipelines and 1 experiment from f.json. Left out 2 pipelines, because this browser keeps at most 20 pipelines and never removes saved ones: A and B. Left out 1 experiment, because this browser keeps at most 20 experiments and never removes saved ones: C.",
    )
    expect(line).not.toMatch(/removed\./)
  })

  it("reports skipped items, a damaged document and one that came back different", () => {
    expect(importResultLine({ ...none, unreadable: 3 })).toBe("f.json has no saved items in it. Skipped 3 items that are not a pipeline or an experiment.")
    expect(importResultLine({ ...none, pipelines: 1, unreadable: 1, damaged: ["a.pdf"], mismatched: ["b.pdf"] })).toBe(
      "Imported 1 pipeline from f.json. Skipped 1 item that is not a pipeline or an experiment. a.pdf: the document in the file is damaged. b.pdf was uploaded, but it is not the document the file names, so saved items may still ask for it.",
    )
  })
})

const DOC = { sha: "1".repeat(64), filename: "x.pdf" }
const BROKEN = { nodes: [{ id: "x", stage: "extract", transform: "y", config: {} }], edges: [] }

describe("export and import with configs", () => {
  it("imports a version 1 file, converting each pipeline or keeping it with its reason", () => {
    const file = {
      format: "rag-playground-library",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      items: [
        { kind: "pipeline", id: "aaaaaaaa", name: "Good", graph: sampleGraph(R, DOC), documents: [DOC], savedAt: "2026-10-01T00:00:00.000Z" },
        { kind: "pipeline", id: "bbbbbbbb", name: "Odd", graph: BROKEN, documents: [], savedAt: "2026-10-01T00:00:00.000Z" },
      ],
      documents: [],
    }
    const r = parseImport(JSON.stringify(file))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pipelines[0].config?.index.parse!.use).toBe("pdfium")
    expect(r.pipelines[1]).toMatchObject({ name: "Odd", config: null, kept: { problem: expect.stringContaining("extract") } })
    expect(r.skipped).toBe(0)
  })

  it("writes version 2 with configs, and a kept item comes back as it went", () => {
    const v1 = parseImport(JSON.stringify({ format: "rag-playground-library", version: 1, exportedAt: "", documents: [], items: [
      { kind: "pipeline", id: "bbbbbbbb", name: "Odd", graph: BROKEN, documents: [], savedAt: "2026-10-01T00:00:00.000Z" },
      { kind: "pipeline", id: "aaaaaaaa", name: "Good", graph: sampleGraph(R, DOC), documents: [DOC], savedAt: "2026-10-02T00:00:00.000Z" },
    ] }))
    if (!v1.ok) throw new Error(v1.error)
    const file = buildExport(libraryItems(v1.pipelines, []), [], Date.parse("2026-10-13T00:00:00Z"))
    expect(file.version).toBe(VERSION)
    expect(VERSION).toBe(2)
    const good = file.items.find((i) => i.name === "Good")!
    expect(good).toHaveProperty("config")
    expect(good).not.toHaveProperty("graph")
    const again = parseImport(JSON.stringify(file))
    if (!again.ok) throw new Error(again.error)
    expect(again.pipelines.find((p) => p.name === "Odd")).toMatchObject({ config: null, kept: { graph: BROKEN } })
    expect(again.pipelines.find((p) => p.name === "Good")?.config).toEqual((good as SavedPipeline).config)
  })

  it("still refuses a file from a newer version", () => {
    const r = parseImport(JSON.stringify({ format: "rag-playground-library", version: 3, items: [] }))
    expect(r).toEqual({ ok: false, error: expect.stringContaining("newer") })
  })

  it("never skips a version 1 pipeline item, even one with no graph at all", () => {
    const r = parseImport(JSON.stringify({ format: "rag-playground-library", version: 1, items: [{ kind: "pipeline", id: "cccccccc", name: "Empty" }] }))
    if (!r.ok) throw new Error(r.error)
    expect(r.skipped).toBe(0)
    expect(r.pipelines[0]).toMatchObject({ id: "cccccccc", name: "Empty", config: null, kept: { problem: expect.any(String) } })
  })

  it("never writes a model key into the file: a pipeline is its settings, documents and question, nothing else", () => {
    const file = buildExport(libraryItems([fromOld({ id: "aaaaaaaa", name: "Good", graph: sampleGraph(R, DOC), savedAt: "2026-10-01T00:00:00Z" }, 0)], []), [], NOW)
    expect(JSON.stringify(file)).not.toMatch(/api_key|apiKey|"keys"/)
    const [item] = file.items as unknown as Record<string, Record<string, unknown>>[]
    expect(Object.keys(item).sort()).toEqual(["config", "documents", "id", "kind", "name", "question", "savedAt"])
    expect(Object.keys(item.config).every((k) => ["index", "retrieve", "answer"].includes(k))).toBe(true)
  })

  it("does not take in a pipeline with a crafted config", () => {
    const r = parseImport(JSON.stringify({ format: "rag-playground-library", version: 2, items: [
      { kind: "pipeline", id: "cccccccc", name: "Crafted", savedAt: "2026-10-01T00:00:00Z", config: { index: { clean: "a" } }, documents: [], question: { text: "", gold_answers: [] } },
    ] }))
    if (!r.ok) throw new Error(r.error)
    expect(r.pipelines).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it("says how many imported pipelines were kept and cannot be opened", () => {
    const base = { fileName: "f.json", pipelines: 2, experiments: 0, already: 0, leftOutPipelines: [], leftOutExperiments: [], unreadable: 0, restored: [], refused: [], damaged: [], mismatched: [] }
    expect(importResultLine({ ...base, kept: 1 })).toBe(
      "Imported 2 pipelines from f.json. 1 was made by an older version and cannot be opened here; the Library shows why.",
    )
    expect(importResultLine({ ...base, kept: 2 })).toBe(
      "Imported 2 pipelines from f.json. 2 were made by an older version and cannot be opened here; the Library shows why.",
    )
  })
})
