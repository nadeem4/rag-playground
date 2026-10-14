import { beforeEach, describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { EvaluationResult, Registry, Totals, Trace, TraceStep } from "@/api/types"

import {
  changeFor,
  changeText,
  hasRetriever,
  percent,
  piecesWarning,
  pipelineLine,
  pipelineSteps,
  readPreviousEvaluation,
  reasonText,
  rerankEffect,
  rerankLine,
  scoreFinding,
  storePreviousEvaluation,
  fixHref,
  type EvalPayload,
} from "./evaluate"
import { e2eSampleGraph, removeNode, sampleGraph } from "./graph"
import { graphToConfig } from "./config"
import { evaluationRequest, rowsFromResult } from "./evaluate"
import { TEST_REGISTRY as R } from "./testRegistry"

const LIVE = liveRegistry as unknown as Registry
const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }


function payload(over: Partial<EvalPayload> = {}): EvalPayload {
  return {
    question: "Why do chunk boundaries matter?",
    gold_answer: "A useful rule of thumb: a chunk should answer one question well.",
    hit: true,
    rank: 1,
    matched_chunk_id: "c1",
    match: "exact",
    considered: 5,
    total_candidates: 20,
    ...over,
  }
}

const miss = (over: Partial<EvalPayload> = {}) => payload({ hit: false, rank: null, matched_chunk_id: "", match: "none", ...over })

/** Totals as the server sends them: this file's fixture, never the page's arithmetic. */
const T = (found: number, total: number): Totals => ({
  total,
  scored: total,
  found,
  hit_rate: total ? found / total : null,
  mrr: null,
  recall: null,
  mean_rank: null,
  median_rank: null,
})
const totalsOf = (ps: readonly EvalPayload[]): Totals => T(ps.filter((p) => p.hit).length, ps.length)

describe("the graph an evaluation runs", () => {
  it("knows a graph with no retriever", () => {
    const g = sampleGraph(LIVE, SRC)
    expect(hasRetriever(g)).toBe(true)
    expect(hasRetriever(removeNode(g, "retrieve"))).toBe(false)
  })

  it("names the steps being evaluated, in column order, plain name beside the code name", () => {
    const named = pipelineSteps(e2eSampleGraph(LIVE, SRC))
    // Each step carries its config, so the next run can tell a settings change from none.
    for (const s of named) expect(typeof s.config).toBe("string")
    expect(named.map(({ config: _config, ...s }) => s)).toEqual([
      { label: "Parse", transform: "docling", name: "Docling" },
      { label: "Clean", transform: "dedupe_blocks", name: "Remove duplicate blocks" },
      { label: "Chunk", transform: "recursive_character", name: "Recursive (natural breaks)" },
      { label: "Index", transform: "lancedb", name: "LanceDB" },
      { label: "Retrieve", transform: "hybrid_rrf", name: "Hybrid (RRF)" },
      { label: "Rerank", transform: "mmr", name: "MMR (variety)" },
    ])
  })

  it("says a pipeline's steps in one line, for a pipeline picker's help line", () => {
    expect(pipelineLine(e2eSampleGraph(LIVE, SRC))).toBe(
      "Docling, Remove duplicate blocks, Recursive (natural breaks), LanceDB, Hybrid (RRF), MMR (variety)",
    )
  })
})

describe("a rate", () => {
  it("reads a rate as a whole percentage, and says nothing when there is no rate", () => {
    expect(percent(0.9)).toBe("90%")
    expect(percent(2 / 3)).toBe("67%")
    expect(percent(null)).toBeNull()
  })
})

const pay = (hit: boolean, rank: number | null, over: Partial<EvalPayload> = {}): EvalPayload => ({
  question: "q",
  gold_answer: "g",
  hit,
  rank,
  matched_chunk_id: hit ? "c" : "",
  match: hit ? "exact" : "none",
  considered: 5,
  total_candidates: 6,
  found_at: null,
  returned: 6,
  ...over,
})
const steps = (parse: string, name: string) => [
  { label: "Parse", transform: parse, name },
  { label: "Chunk", transform: "recursive_character", name: "Recursive (natural breaks)" },
]

describe("the warning about too few pieces", () => {
  it("says nothing when the number of pieces is not known", () => {
    expect(piecesWarning(null, 5, [])).toBeNull()
  })

  it("says the score means nothing when every piece is checked", () => {
    expect(piecesWarning(1, 5, [])).toBe("This pipeline makes only 1 piece, so every question finds its answer. The score says nothing here.")
    expect(piecesWarning(5, 5, [])).toBe("This pipeline makes only 5 pieces, so every question finds its answer. The score says nothing here.")
  })

  it("does not claim every question finds its answer when one missed", () => {
    expect(piecesWarning(5, 5, [pay(false, null, { returned: 5 })])).toBe(
      "With 5 pieces and 5 checked, a hit says little. A miss still says a lot: the answer was in none of the 5 pieces.",
    )
  })

  it("says a question can find its answer by chance when the pieces are few", () => {
    expect(piecesWarning(6, 5, [])).toBe(
      "This pipeline makes only 6 pieces and checks 5 of them, so a question can find its answer by chance. Use smaller pieces or check fewer to make the score mean more.",
    )
    expect(piecesWarning(10, 5, [])).not.toBeNull()
  })

  it("words the pieces caveat for a run with misses, and stays honest about where the answer was", () => {
    expect(piecesWarning(6, 5, [pay(false, null)])).toBe("With 6 pieces and 5 checked, a hit says little. A miss still says a lot: the answer was in none of the 6 pieces.")
    expect(piecesWarning(6, 5, [pay(false, null, { found_at: 6 })])).toBe("With 6 pieces and 5 checked, a hit says little. A miss still says a lot: its answer was not in the top 5.")
    expect(piecesWarning(6, 5, [pay(false, null), pay(false, null, { found_at: 6 })])).toBe(
      "With 6 pieces and 5 checked, a hit says little. A miss still says a lot: its answer was not in the top 5.",
    )
    // Fewer pieces came back than the pipeline made, so "none of the 6" is not known.
    expect(piecesWarning(6, 5, [pay(false, null, { returned: 5 })])).toBe(
      "With 6 pieces and 5 checked, a hit says little. A miss still says a lot: its answer was not in the top 5.",
    )
    expect(piecesWarning(6, 5, [])).toBe("This pipeline makes only 6 pieces and checks 5 of them, so a question can find its answer by chance. Use smaller pieces or check fewer to make the score mean more.")
  })

  it("says nothing when there are enough pieces", () => {
    expect(piecesWarning(11, 5, [])).toBeNull()
    expect(piecesWarning(11, 5, [pay(false, null)])).toBeNull()
  })
})

describe("the reason for a row", () => {
  it("gives each row its reason as one sentence", () => {
    expect(reasonText(pay(true, 1), 5)).toBe("Found in the 1st piece, word for word.")
    expect(reasonText(pay(true, 2, { match: "normalized" }), 5)).toBe("Found in the 2nd piece, after ignoring spacing and capitals.")
    expect(reasonText(pay(true, 1, { match: "reworded" }), 5)).toBe(
      "Found in the 1st piece, after setting aside list numbers, bullets and stray letters the parser changed.",
    )
    expect(reasonText(pay(false, null, { found_at: 7 }), 5)).toBe("Found 7th, below the 5 pieces checked.")
    expect(reasonText(pay(false, null, { returned: 6 }), 5)).toBe("Not in any of the 6 pieces that came back, so no number of pieces checked would find it.")
  })

  it("falls back to what was checked on an older payload without the returned count", () => {
    expect(reasonText(miss({ considered: 5, total_candidates: 12 }), 5)).toBe("5 of 12 checked")
  })
})

describe("the score as a finding", () => {
  const prev = (over: Record<string, unknown> = {}) => ({
    sourceSha: "s",
    pipelineKey: "working",
    byId: {},
    totals: T(5, 5),
    steps: steps("docling", "Docling"),
    ...over,
  })

  it("says the score and the last run's score as one finding", () => {
    const now = [pay(true, 1), pay(true, 1), pay(false, null), pay(false, null), pay(true, 1)]
    const before = prev()
    // Every question was found 1st last time, so both misses are losses.
    const f = scoreFinding(totalsOf(now), before, now.map((p) => ({ now: p, before: pay(true, 1) })), steps("pdfium", "Fast text"), 5)
    expect(f.finding).toBe("3 of 5 questions found the answer. The last run found 5 of 5.")
    expect(f.sub).toBe("Hit rate at 5 pieces: 60%. Both misses are new since Parse changed to Fast text.")
    // The note is the sub line without the hit rate, which the numbers row already shows.
    expect(f.note).toBe("Both misses are new since Parse changed to Fast text.")
  })

  it("says every answer came back first on a clean first run", () => {
    const now = [pay(true, 1), pay(true, 1)]
    const f = scoreFinding(totalsOf(now), null, now.map((p) => ({ now: p })), steps("docling", "Docling"), 5)
    expect(f.finding).toBe("2 of 2 questions found the answer.")
    expect(f.sub).toBe("Hit rate at 5 pieces: 100%. Every answer came back as the top piece.")
    expect(f.note).toBe("Every answer came back as the top piece.")
  })

  it("counts the new misses, and says since the last run when no single step changed", () => {
    const one = [pay(true, 1), pay(false, null)]
    expect(scoreFinding(totalsOf(one), prev({ steps: undefined }), one.map((p) => ({ now: p, before: pay(true, 1) })), steps("pdfium", "Fast text"), 5).sub).toBe(
      "Hit rate at 5 pieces: 50%. The miss is new since the last run.",
    )
    const three = [pay(false, null), pay(false, null), pay(false, null)]
    expect(scoreFinding(totalsOf(three), prev(), three.map((p) => ({ now: p, before: pay(true, 2) })), steps("docling", "Docling"), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. All 3 misses are new since the last run.",
    )
    const some = three.map((p, i) => ({ now: p, before: i === 2 ? pay(false, null) : pay(true, 1) }))
    expect(scoreFinding(totalsOf(three), prev(), some, steps("pdfium", "Fast text"), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. 2 of the 3 misses are new since Parse changed to Fast text.",
    )
  })

  it("names a change only when exactly one step's transform differs", () => {
    const now = [pay(false, null)]
    const two = [
      { label: "Parse", transform: "pdfium", name: "Fast text" },
      { label: "Chunk", transform: "token_based", name: "Fixed token count" },
    ]
    expect(scoreFinding(totalsOf(now), prev(), [{ now: now[0], before: pay(true, 1) }], two, 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since the last run.",
    )
  })

  it("says piece, not pieces, when one is checked", () => {
    expect(scoreFinding(totalsOf([pay(true, 2)]), null, [{ now: pay(true, 2) }], steps("docling", "Docling"), 1).sub).toBe("Hit rate at 1 piece: 100%.")
  })

  it("names a step only when its settings are the one change, and the pieces checked did not change", () => {
    const now = [pay(false, null)]
    const rows = [{ now: now[0], before: pay(true, 1) }]
    const withConfig = (parse: string, name: string, size: number) => [
      { label: "Parse", transform: parse, name, config: "{}" },
      { label: "Chunk", transform: "recursive_character", name: "Recursive (natural breaks)", config: JSON.stringify({ chunk_size: size }) },
    ]
    const before = prev({ steps: withConfig("docling", "Docling", 400), k: 5 })
    expect(scoreFinding(totalsOf(now), before, rows, withConfig("pdfium", "Fast text", 400), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since Parse changed to Fast text.",
    )
    // The chunk size changed in the same trip to Build, so Parse alone is not the cause.
    expect(scoreFinding(totalsOf(now), before, rows, withConfig("pdfium", "Fast text", 200), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since the last run.",
    )
    // Only a setting changed, so the step is named without a new name.
    expect(scoreFinding(totalsOf(now), before, rows, withConfig("docling", "Docling", 200), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since Chunk's settings changed.",
    )
    // Pieces checked changed between the runs.
    expect(scoreFinding(totalsOf(now), before, rows, withConfig("pdfium", "Fast text", 400), 3).sub).toBe(
      "Hit rate at 3 pieces: 0%. The miss is new since the last run.",
    )
  })

  it("says nothing more when the misses are old, or the hits are not all first", () => {
    const now = [pay(true, 2), pay(false, null)]
    expect(scoreFinding(totalsOf(now), prev(), now.map((p) => ({ now: p, before: p })), steps("docling", "Docling"), 5).sub).toBe("Hit rate at 5 pieces: 50%.")
    expect(scoreFinding(totalsOf([pay(true, 2)]), null, [{ now: pay(true, 2) }], steps("docling", "Docling"), 3)).toEqual({
      finding: "1 of 1 question found the answer.",
      sub: "Hit rate at 3 pieces: 100%.",
      note: "",
    })
  })
})

describe("the change since the previous evaluation", () => {
  it("is nothing without a previous run", () => {
    expect(changeFor(payload(), undefined)).toBe("none")
  })

  it("marks a question that now finds the answer and one that no longer does", () => {
    expect(changeFor(payload(), miss())).toBe("found")
    expect(changeFor(miss(), payload())).toBe("lost")
  })

  it("marks a rank that rose or fell, and says nothing when it held", () => {
    expect(changeFor(payload({ rank: 1 }), payload({ rank: 4 }))).toBe("up")
    expect(changeFor(payload({ rank: 4 }), payload({ rank: 1 }))).toBe("down")
    expect(changeFor(payload({ rank: 2 }), payload({ rank: 2 }))).toBe("none")
    expect(changeFor(miss(), miss())).toBe("none")
  })

  it("says what it was, in words", () => {
    expect(changeText("found", miss())).toBe("Was missed")
    expect(changeText("lost", payload({ rank: 1 }))).toBe("Was found 1st")
    expect(changeText("lost", payload({ rank: 2 }))).toBe("Was found 2nd")
    expect(changeText("up", payload({ rank: 5 }))).toBe("Was found 5th")
    expect(changeText("none", payload())).toBeNull()
  })
})

describe("the previous evaluation of the session", () => {
  it("reads an older stored run that has no recipe", () => {
    window.sessionStorage.setItem(
      "rag-playground:evaluation:previous",
      JSON.stringify({
        "s|working": { sourceSha: "s", pipelineKey: "working", byId: {}, totals: T(1, 2) },
      }),
    )
    expect(readPreviousEvaluation("s", "working")?.totals.found).toBe(1)
    expect(readPreviousEvaluation("s", "working")?.steps).toBeUndefined()
  })

  it("reads an entry an older page stored, with its own summary and no totals, as none", () => {
    window.sessionStorage.setItem(
      "rag-playground:evaluation:previous",
      JSON.stringify({
        "s|working": { sourceSha: "s", pipelineKey: "working", byId: {}, summary: { hits: 1, total: 2, averageRank: 1 } },
      }),
    )
    expect(readPreviousEvaluation("s", "working")).toBeNull()
  })

  it("keeps the recipe it was scored with", () => {
    storePreviousEvaluation({ sourceSha: "s", pipelineKey: "working", byId: {}, totals: T(1, 2), steps: steps("docling", "Docling") })
    expect(readPreviousEvaluation("s", "working")?.steps).toEqual(steps("docling", "Docling"))
  })

  const SHA = "cd".repeat(32)
  const OTHER_SHA = "ab".repeat(32)

  beforeEach(() => window.sessionStorage.clear())

  it("is nothing before the first run", () => {
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("comes back as it went in, so a trip to Build and back keeps it, for the same document and pipeline", () => {
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, totals: totalsOf([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(SHA, "working")).toEqual(before)
  })

  it("is ignored when it was recorded against a different document (F5)", () => {
    // Score the primer, load Scanned notes, evaluate: the primer's "10 of 10"
    // must not be compared against Scanned notes' own run.
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, totals: totalsOf([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(OTHER_SHA, "working")).toBeNull()
  })

  it("is ignored when it was recorded against a different pipeline", () => {
    // Stored for the saved pipeline "working" carries a run scored with a
    // different pipeline: the score under "abc" must not borrow it.
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, totals: totalsOf([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(SHA, "abc")).toBeNull()
  })

  it("treats a stored result with no pipelineKey (old shape) as none", () => {
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify({ sourceSha: SHA, byId: {}, totals: totalsOf([]) }))
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("keeps one previous score per pipeline, so scoring A, then B, then A again still finds A's (I2)", () => {
    const a = { sourceSha: SHA, pipelineKey: "A", byId: { a: payload({ rank: 1 }) }, totals: totalsOf([payload()]) }
    const b = { sourceSha: SHA, pipelineKey: "B", byId: { a: payload({ rank: 4 }) }, totals: totalsOf([miss()]) }
    storePreviousEvaluation(a)
    storePreviousEvaluation(b)
    expect(readPreviousEvaluation(SHA, "A")).toEqual(a)
    expect(readPreviousEvaluation(SHA, "B")).toEqual(b)
  })

  it("treats the old single-slot shape as none, even for its own document and pipeline", () => {
    const old = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, totals: totalsOf([payload()]) }
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify(old))
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("keeps at most 40 scores, dropping the oldest", () => {
    const one = (k: string) => ({ sourceSha: SHA, pipelineKey: k, byId: {}, totals: totalsOf([]) })
    for (let i = 0; i < 41; i++) storePreviousEvaluation(one(`p${i}`))
    expect(readPreviousEvaluation(SHA, "p0")).toBeNull()
    expect(readPreviousEvaluation(SHA, "p1")).not.toBeNull()
    expect(readPreviousEvaluation(SHA, "p40")).not.toBeNull()
  })

  it("is nothing when the stored value is not an evaluation", () => {
    window.sessionStorage.setItem("rag-playground:evaluation:previous", "{oops")
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify({ byId: 7 }))
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })
})

describe("what the reranker did", () => {
  const rows = (...xs: [string, number, number | null][]) => xs.map(([chunk_id, rank, prior_rank]) => ({ chunk_id, rank, prior_rank }))

  it("counts the questions whose answer it moved up and down, by the rank the answer came from", () => {
    const e = rerankEffect([
      { payload: payload({ rank: 1, matched_chunk_id: "c1" }), rows: rows(["c1", 1, 3]) },
      { payload: payload({ rank: 4, matched_chunk_id: "c2" }), rows: rows(["c2", 4, 2]) },
      { payload: payload({ rank: 2, matched_chunk_id: "c3" }), rows: rows(["c3", 2, 2]) },
      { payload: miss(), rows: rows(["c9", 1, 5]) },
    ])
    expect(e).toEqual({ up: 1, down: 1, same: 1, judged: 3 })
  })

  it("judges nothing when no rank was recorded before the rerank", () => {
    const e = rerankEffect([{ payload: payload({ matched_chunk_id: "c1" }), rows: rows(["c1", 1, null]) }])
    expect(e).toEqual({ up: 0, down: 0, same: 0, judged: 0 })
    expect(rerankLine(e)).toBeNull()
  })

  it("reads as a sentence that says what it counted", () => {
    expect(rerankLine({ up: 3, down: 1, same: 1, judged: 5 })).toBe(
      "Rerank moved the answer up for 3 of the 5 questions that found it, and down for 1.",
    )
  })
})

describe("fixHref", () => {
  const g = e2eSampleGraph(LIVE, SRC)
  const idOf = (stage: string) => g.nodes.find((n) => n.stage === stage)!.id
  it("links a lost step to its card on Build, and the second cleaner to the second Clean card", () => {
    const steps = (stages: string[], lost: number) =>
      stages.map((stage, i) => ({ stage, name: stage, status: i === lost ? "lost" : "pass", sentence: "", evidence: null })) as TraceStep[]
    const trace = (stages: string[], lost: number): Trace => ({ finding: "", lost_at: null, fix: null, golds: [], steps: steps(stages, lost) })
    expect(fixHref(g, trace(["parse", "clean", "chunk"], 0))).toBe(`/build?step=${idOf("parse")}`)
    expect(fixHref(g, trace(["parse", "clean", "chunk", "search"], 3))).toBe(`/build?step=${idOf("retrieve")}`)
    expect(fixHref(g, trace(["parse", "clean", "chunk", "search", "rerank"], 4))).toBe(`/build?step=${idOf("rerank")}`)
    expect(fixHref(g, trace(["parse", "clean", "chunk", "search", "top_k"], 4))).toBeNull()
    expect(fixHref(g, trace(["parse", "clean", "chunk"], -1))).toBeNull()
    const first = idOf("clean")
    const twoCleans = {
      nodes: [...g.nodes, { ...g.nodes.find((n) => n.id === first)!, id: "clean_2" }],
      edges: g.edges.flatMap((e) => (e.src === first ? [{ ...e, src: "clean_2" }, { src: first, dst: "clean_2", port: e.port }] : [e])),
    }
    expect(fixHref(twoCleans, trace(["parse", "clean", "clean", "chunk"], 2))).toBe("/build?step=clean_2")
  })
})

const DOC = { sha: "2".repeat(64), filename: "e.pdf" }
const QUESTIONS = [
  { id: "q1", question: "What is a chunk?", gold_answers: ["A chunk is a piece."], tags: ["easy"] },
  { id: "q2", question: "Why overlap?", gold_answers: ["Overlap keeps context."], tags: [] },
]
const TOTALS = { total: 2, scored: 2, found: 1, hit_rate: 0.5, mrr: 0.5, recall: null, mean_rank: 1, median_rank: 1 }

describe("one evaluation request", () => {
  it("sends the whole question set, the pipeline and its documents at once", () => {
    const c = graphToConfig(sampleGraph(R, DOC))
    if (!c.ok) throw new Error(c.problem)
    expect(evaluationRequest(c.pipeline, QUESTIONS, 5)).toEqual({
      config: c.pipeline.config,
      documents: [DOC.sha],
      questions: QUESTIONS.map(({ id, question, gold_answers, tags }) => ({ id, question, gold_answers, tags })),
      top_k: 5,
    })
  })

  it("reads each question's verdict from the server's result", () => {
    const result = { ...TOTALS, top_k: 5, cancelled: false, by_tag: {}, questions: [
      { id: "q1", question: "", golds: [], tags: [], found: true, rank: 1, lost_at: null, trace: null, score: { hit: true, rank: 1 }, error: null, result_id: "r1" },
    ] } as unknown as EvaluationResult
    expect(rowsFromResult(result).q1.result_id).toBe("r1")
    expect(rowsFromResult(null)).toEqual({})
  })

  it("words the score from the server's totals", () => {
    const f = scoreFinding(TOTALS, null, [], [], 5)
    expect(f.finding).toBe("1 of 2 questions found the answer.")
    expect(f.sub).toBe("Hit rate at 5 pieces: 50%.")
  })
})

it("the browser no longer adds up scores", async () => {
  const mod = await import("./evaluate")
  for (const name of ["metrics", "summarize", "metricsByTag", "batches", "questionVariants", "evalGraph", "traceRequest"]) {
    expect(mod).not.toHaveProperty(name)
  }
})
