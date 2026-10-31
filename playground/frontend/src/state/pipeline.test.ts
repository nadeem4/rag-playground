import { describe, expect, it } from "vitest"

import { ApiError } from "@/api/client"
import type { NodeState } from "@/api/runState"

import { graphToConfig, type WorkingPipeline } from "./config"
import { addCleaner, columnOrder, initialGraph, removeNode, sampleGraph, type PipelineGraph } from "./graph"
import { askRun, cardRun, foldRun, mergeResults, problemDetails, routeRunError, type Tracked } from "./pipeline"
import { TEST_REGISTRY as R } from "./testRegistry"

const DOC = { sha: "c".repeat(64), filename: "a.pdf" }
const working = (g: PipelineGraph = sampleGraph(R, DOC)): WorkingPipeline => {
  const c = graphToConfig(g)
  if (!c.ok) throw new Error(c.problem)
  return c.pipeline
}
/** Two cleaners, the first removed, then one added: a lone clean_2 (`gap`), then [clean_2, clean_1] (`swapped`). */
const gap = removeNode(addCleaner(sampleGraph(R, DOC), R), "clean_1")
const swapped = addCleaner(gap, R)

describe("cardRun", () => {
  it.each([
    ["source", "parse"],
    ["parse", "parse"],
    ["clean_1", "clean.1"],
    ["chunk", "chunk"],
    ["index", "index"],
  ])("runs the %s card through %s, on the pipeline's documents", (card, through) => {
    const p = working()
    expect(cardRun(p, card, false, sampleGraph(R, DOC))).toEqual({ config: p.config, documents: [DOC.sha], through })
  })

  it("asks for every step again only when forced", () => {
    expect(cardRun(working(), "chunk", true, sampleGraph(R, DOC)).force).toBe(true)
  })

  it("runs a cleaner through its place in the column, not its id", () => {
    expect(cardRun(working(gap), "clean_2", false, gap).through).toBe("clean.1")
    expect(cardRun(working(swapped), "clean_2", false, swapped).through).toBe("clean.1")
    expect(cardRun(working(swapped), "clean_1", false, swapped).through).toBe("clean.2")
  })
})

/** A 422 as pandion-api sends it: each problem's sentence, and where Pandion placed it. */
const refusal = (...placed: [message: string, step: string | null][]) =>
  new ApiError(422, { problems: placed.map(([m]) => m), details: placed.map(([message, step]) => ({ message, step, use: null, settings: [] })) }, "/runs")

describe("routeRunError on /api/v2", () => {
  const g = sampleGraph(R, DOC)
  it("puts a problem on the card Pandion placed it on", () => {
    expect(routeRunError(refusal(["chunk_overlap must be smaller than chunk_size.", "index.chunk"]), g)).toEqual({
      kind: "node",
      nodeId: "chunk",
      message: "chunk_overlap must be smaller than chunk_size.",
    })
  })

  it("puts a problem that is no one step's on the column", () => {
    expect(routeRunError(refusal(["The pipeline must be a mapping of settings.", null]), g)).toEqual({ kind: "column", message: "The pipeline must be a mapping of settings." })
  })

  it("never reads the sentence for a card: without a place it is the column's", () => {
    const err = new ApiError(422, { problems: ["index.chunk: chunk_overlap must be smaller than chunk_size."] }, "/runs")
    expect(routeRunError(err, g)).toMatchObject({ kind: "column" })
  })

  it("puts a problem with a stacked step on the card at that place", () => {
    expect(routeRunError(refusal(["similarity must be at most 1.", "index.clean.2"]), swapped)).toEqual({ kind: "node", nodeId: "clean_1", message: "similarity must be at most 1." })
    expect(routeRunError(refusal(["similarity must be at most 1.", "index.clean.1"]), gap)).toMatchObject({ kind: "node", nodeId: "clean_2" })
  })

  it("puts a problem on the column when the card it belongs to is not in the column", () => {
    expect(routeRunError(refusal(["bad", "index.clean.2"]), gap)).toEqual({ kind: "column", message: "bad" })
    expect(routeRunError(refusal(["answer: bad", "answer"]), removeNode(g, "use_case"))).toEqual({ kind: "column", message: "answer: bad" })
  })

  it("puts problems placed on different cards on the column, all of them", () => {
    const two = refusal(["chunk_size must be at least 1.", "index.chunk"], ["top_k must be at least 1.", "retrieve.search"])
    expect(routeRunError(two, g)).toEqual({ kind: "column", message: "chunk_size must be at least 1. top_k must be at least 1." })
    const same = refusal(["chunk_size must be at least 1.", "index.chunk"], ["chunk_overlap must be at least 0.", "index.chunk"])
    expect(routeRunError(same, g)).toMatchObject({ kind: "node", nodeId: "chunk" })
  })

  it("says the demo's capacity refusals in their own sentence, above the column", () => {
    const sentences: [number, string][] = [
      [429, "You already have 2 runs going. Wait for one to finish, or stop one."],
      [413, "The demo scores at most 50 questions in one run, and this set has 51. Use fewer questions, or run the playground locally for more."],
      [413, "The demo scores at most 120 recipe-questions in one comparison (recipes times questions), and this one asks for 123. Use fewer recipes or questions, or run the playground locally for more."],
    ]
    for (const [status, message] of sentences) {
      for (const path of ["/runs", "/ask", "/evaluations", "/comparisons"]) {
        expect(routeRunError(new ApiError(status, message, path), g)).toEqual({ kind: "column", message })
      }
    }
  })

  it("says a request the server refused field by field in plain words, not as JSON", () => {
    const detail = [{ type: "string_too_long", loc: ["body", "question"], msg: "String should have at most 2000 characters", input: "x" }]
    expect(routeRunError(new ApiError(422, detail, "/ask"), g)).toEqual({ kind: "column", message: "question: String should have at most 2000 characters." })
  })
})

describe("askRun", () => {
  it("asks the pipeline's question on its documents", () => {
    const p = { ...working(), question: { text: "What is a chunk?", gold_answers: [] } }
    expect(askRun(p, { answer: true, force: false })).toEqual({ config: p.config, documents: [DOC.sha], question: "What is a chunk?", answer: true })
  })

  it("stops before the answer when told to", () => {
    expect(askRun(working(), { answer: false, force: true })).toMatchObject({ answer: false, force: true })
  })

  it("searches one document only when Search in names it", () => {
    expect(askRun(working(), { answer: true, force: false, document: DOC.sha })).toMatchObject({ where: { document: [DOC.sha] } })
    expect(askRun(working(), { answer: true, force: false, document: null })).not.toHaveProperty("where")
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

describe("problemDetails", () => {
  const detail = { message: "m", step: "index.chunk", use: "recursive_character", settings: [{ field: "chunk_size", message: "Too small." }] }
  it("reads where Pandion placed each problem", () => {
    expect(problemDetails({ problems: ["m"], details: [detail] })).toEqual([detail])
  })

  it("is null for a refusal that carries none: an older server, or a site rule's own words", () => {
    expect(problemDetails({ problems: ["m"] })).toBeNull()
    expect(problemDetails({ problems: ["m"], details: [] })).toBeNull()
    expect(problemDetails("Not allowed.")).toBeNull()
    expect(problemDetails({ details: [{ step: "x" }] })).toBeNull()
  })
})

describe("pinned categories in a request", () => {
  const pinned = (): WorkingPipeline => ({ ...working(), documents: [{ ...DOC, category: "reports" }] })

  it("sends categories for pinned documents and omits the field otherwise", () => {
    expect(cardRun(pinned(), "chunk", false, sampleGraph(R, DOC)).categories).toEqual({ [DOC.sha]: "reports" })
    expect(askRun(pinned(), { answer: false, force: false }).categories).toEqual({ [DOC.sha]: "reports" })
    expect("categories" in cardRun(working(), "chunk", false, sampleGraph(R, DOC))).toBe(false)
    expect("categories" in askRun(working(), { answer: false, force: false })).toBe(false)
  })
})
