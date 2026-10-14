import { describe, expect, it } from "vitest"

import type { Registry, Totals } from "@/api/types"
import type { NodeState } from "@/api/runState"
import liveRegistry from "@/api/fixtures/registry.json"

import { evalStripLine, indexLine, indexSteps, numbersRow, progressLine, runSummary, searchSteps, slowReadNote, staleLine, evidenceCells } from "./evaluateView"
import { sampleGraph, setConfig, setTransform } from "./graph"

const registry = liveRegistry as unknown as Registry

const state = (status: NodeState["status"], id = "x"): NodeState => ({ id, status })

describe("numbersRow", () => {
  /** The server's totals (pandion.evaluation), as /api/v2/evaluations returns them. */
  const totals = (over: Partial<Totals> = {}): Totals => ({
    total: 4,
    scored: 4,
    found: 3,
    hit_rate: 0.75,
    mrr: 0.4583,
    recall: null,
    mean_rank: 2,
    median_rank: 2,
    ...over,
  })

  it("names each number with its technical name and the k it was scored at", () => {
    const row = numbersRow(totals(), null, 5)
    expect(row.map((n) => n.label)).toEqual([
      "Hit rate (Hit@5)",
      "Mean reciprocal rank (MRR)",
      "Average rank when found (mean rank)",
      "Middle rank when found (median rank)",
    ])
    expect(row.map((n) => n.value)).toEqual(["75%", "0.46", "2.0", "2"])
    expect(row.every((n) => n.was === null)).toBe(true)
  })

  it("adds recall only when the server sends one", () => {
    const row = numbersRow(totals({ recall: 0.5 }), null, 5)
    expect(row.map((n) => n.label)).toContain("Evidence found (recall at 5)")
    expect(row.find((n) => n.label.startsWith("Evidence"))!.value).toBe("50%")
  })

  it("says what each number was when the last run differs, and nothing when it is the same", () => {
    const now = totals({ total: 2, scored: 2, found: 2, hit_rate: 1, mrr: 1, mean_rank: 1, median_rank: 1 })
    const before = totals({ total: 2, scored: 2, found: 1, hit_rate: 0.5, mrr: 0.5, mean_rank: 1, median_rank: 1 })
    const row = numbersRow(now, before, 5)
    expect(row[0]).toMatchObject({ value: "100%", was: "50%" })
    expect(row[2]).toMatchObject({ value: "1.0", was: null })
  })

  it("says none when nothing was found, rather than a number", () => {
    const row = numbersRow(totals({ found: 0, hit_rate: 0, mrr: 0, mean_rank: null, median_rank: null }), null, 5)
    expect(row[2].value).toBe("none")
    expect(row[3].value).toBe("none")
  })
})

describe("indexLine", () => {
  const ids = ["parse", "chunk", "index"]
  it("says the index came from the cache when every index step was a cache hit", () => {
    expect(indexLine({ parse: state("cached"), chunk: state("cached"), index: state("cached") }, ids, (id) => id)).toEqual({
      label: "From the cache",
      cached: true,
    })
  })
  it("says it was built now when any index step ran", () => {
    expect(indexLine({ parse: state("cached"), chunk: state("done"), index: state("done") }, ids, (id) => id)).toEqual({
      label: "Built now",
      cached: false,
    })
  })
  it("names the step that is running", () => {
    expect(indexLine({ parse: state("done"), chunk: state("running"), index: state("pending") }, ids, (id) => (id === "chunk" ? "Chunk" : id))).toEqual({
      label: "Building: Chunk",
      cached: false,
    })
  })
  it("says it is waiting before anything starts", () => {
    expect(indexLine({}, ids, (id) => id)).toEqual({ label: "Waiting to start", cached: false })
  })
})

describe("progressLine", () => {
  it("counts the question being scored and the searches that came from the cache", () => {
    expect(progressLine(2, 6, 2)).toBe("Searching and scoring question 3 of 6. 2 searches came from the cache.")
    expect(progressLine(0, 6, 0)).toBe("Searching and scoring question 1 of 6.")
    expect(progressLine(1, 6, 1)).toBe("Searching and scoring question 2 of 6. 1 search came from the cache.")
    expect(progressLine(6, 6, 0)).toBe("Scored all 6 questions.")
  })

  it("says the index comes first while it is being built, instead of a question count", () => {
    expect(progressLine(0, 6, 0, true)).toBe("Building the index first. Questions are scored once it is ready.")
  })
})

describe("staleLine", () => {
  it("says the run was scored at another k, and nothing when they agree", () => {
    expect(staleLine(5, 3)).toBe("Scored at 5 pieces. Evaluate again to use 3.")
    expect(staleLine(1, 4)).toBe("Scored at 1 piece. Evaluate again to use 4.")
    expect(staleLine(5, 5)).toBeNull()
    expect(staleLine(null, 5)).toBeNull()
  })
})

describe("the two recipe lines", () => {
  const g = sampleGraph(registry, { sha: "cd".repeat(32), filename: "x.pdf" })
  it("lists the index side by plain name and code name", () => {
    expect(indexSteps(g).map((s) => s.label)).toEqual(["Parse", "Clean", "Chunk", "Index"].filter((l) => indexSteps(g).some((s) => s.label === l)))
    expect(indexSteps(g).every((s) => s.label !== "Retrieve")).toBe(true)
  })
  it("lists the search side: rewrite, retrieve with how many it returns, and rerank", () => {
    const parts = searchSteps(g)
    expect(parts.map((p) => p.label)).toEqual(["Rewrite", "Retrieve", "Rerank"])
    expect(parts[0].name).toBe("None")
    const retrieve = parts[1]
    expect(retrieve.transform).toBeTruthy()
    expect(retrieve.detail).toMatch(/^returns \d+$/)
  })
  it("says PRF when the retriever borrows words", () => {
    const r = g.nodes.find((n) => n.stage === "retrieve")!
    const withPrf = setConfig(setTransform(g, r.id, "hybrid_rrf", registry), r.id, { ...r.config, query_expansion: "prf" })
    expect(searchSteps(withPrf)[0].name).toBe("PRF")
  })
})

describe("evidenceCells", () => {
  it("splits a table row into its cells, and leaves a sentence alone", () => {
    expect(evidenceCells("| Satisfaction score | 6.1 | 8.3 | +2.2 |")).toEqual(["Satisfaction score", "6.1", "8.3", "+2.2"])
    expect(evidenceCells("A table is a good home for a number.")).toBeNull()
  })
})

describe("evalStripLine", () => {
  const ids = ["parse", "chunk", "index"]
  const title = (id: string) => id[0].toUpperCase() + id.slice(1)
  it("names the step running now, with when it started", () => {
    expect(evalStripLine({ parse: { ...state("done"), duration_ms: 900 }, chunk: { ...state("running"), started_at: 12 } }, ids, title, false)).toEqual({
      kind: "running",
      title: "Chunk",
      startedAt: 12,
    })
  })
  it("says the index came from the cache when every step was a cache hit", () => {
    expect(evalStripLine({ parse: state("cached"), chunk: state("cached"), index: state("cached") }, ids, title, false)).toEqual({ kind: "reused" })
  })
  it("gives the build time once every step is done, counting only the steps that ran", () => {
    expect(
      evalStripLine({ parse: { ...state("done"), duration_ms: 2000 }, chunk: { ...state("cached"), duration_ms: 5 }, index: { ...state("done"), duration_ms: 400 } }, ids, title, false),
    ).toEqual({ kind: "built", totalMs: 2400 })
  })
  it("says it is queued on the busy demo, and nothing before any step reports", () => {
    expect(evalStripLine({}, ids, title, true)).toEqual({ kind: "queued" })
    expect(evalStripLine({}, ids, title, false)).toBeNull()
  })
})

describe("slowReadNote", () => {
  it("explains a slow first read while Docling or OCR is running, and says nothing otherwise", () => {
    expect(slowReadNote({ ...state("running"), transform: "docling" })).toBe(
      "Docling reads the page layout, so the first read of a document can take a minute or two. Later runs come from the cache.",
    )
    expect(slowReadNote({ ...state("running"), transform: "pdfium" })).toBeNull()
    expect(slowReadNote({ ...state("done"), transform: "docling" })).toBeNull()
    expect(slowReadNote(undefined)).toBeNull()
  })
})

describe("runSummary", () => {
  it("says what came from the cache and how long the run took", () => {
    expect(runSummary(10, 10, 400)).toBe("10 searches, all from the cache. Took 0.4 s.")
    expect(runSummary(10, 7, 12_300)).toBe("10 searches: 7 from the cache, 3 ran now. Took 12 s.")
    expect(runSummary(1, 0, 2_500)).toBe("1 search, ran now. Took 2.5 s.")
    expect(runSummary(6, 2, null)).toBe("6 searches: 2 from the cache, 4 ran now.")
  })
})
