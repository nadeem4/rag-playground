import { describe, expect, it } from "vitest"

import type { SampleCard, Source } from "@/api/types"

import { initialGraph } from "./graph"
import {
  SOON_HOURS,
  base64ToBytes,
  buildExport,
  bytesToBase64,
  docState,
  experimentSummary,
  exportFileName,
  importResultLine,
  libraryItems,
  parseImport,
  pipelineSummary,
  uploadsOf,
} from "./library"
import type { SavedExperiment } from "./libraryExperiments"
import type { SavedPipeline } from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"

const UP = "ab".repeat(32)
const SAMPLE = "cd".repeat(32)
const NOW = Date.parse("2026-10-04T12:00:00Z")

const pipeline = (id: string, savedAt: string, sha = UP): SavedPipeline => {
  const g = initialGraph(R)
  return {
    id,
    name: `Pipeline ${id}`,
    savedAt,
    graph: { ...g, nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, config: { ...n.config, sha, filename: "notes.pdf" } } : n)) },
  }
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
    expect(items[1].doc).toEqual({ sha: UP, filename: "notes.pdf" })
  })

  it("sums up a pipeline by its steps and an experiment by its step and recipe count", () => {
    expect(pipelineSummary(pipeline("p", "2026-10-01T00:00:00Z").graph)).toMatch(/^[^,]+(, [^,]+)+$/)
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
    expect(file.version).toBe(1)
    expect(file.exportedAt).toBe("2026-10-04T12:00:00.000Z")
    expect(file.items.map((i) => i.kind)).toEqual(["experiment", "pipeline"])
    const back = parseImport(JSON.stringify(file))
    if (!back.ok) throw new Error(back.error)
    expect(back.pipelines.map((p) => p.id)).toEqual(["p1"])
    expect(back.pipelines[0].graph).toEqual(items[1].kind === "pipeline" ? items[1].pipeline.graph : null)
    expect(back.experiments.map((e) => e.id)).toEqual(["e1"])
    expect(Array.from(base64ToBytes(back.documents[0].pdfBase64))).toEqual([37, 80, 68, 70])
  })

  it("refuses a file that is not a library export, in plain words", () => {
    expect(parseImport("not json")).toEqual({ ok: false, error: "This is not a RAG Playground file. Export from Library makes one." })
    expect(parseImport(JSON.stringify({ format: "other" })).ok).toBe(false)
    expect(parseImport(JSON.stringify({ format: "rag-playground-library", version: 2, items: [] }))).toEqual({
      ok: false,
      error: "This file was made by a newer RAG Playground. Update this copy to import it.",
    })
  })

  it("skips items and documents it cannot read, and an experiment with more than ten recipes", () => {
    const tooMany = { ...experiment("big", "2026-10-02T00:00:00Z"), kind: "experiment", recipes: Array.from({ length: 11 }, () => ({ transform: "t", config: {} })) }
    const r = parseImport(
      JSON.stringify({
        format: "rag-playground-library",
        version: 1,
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
