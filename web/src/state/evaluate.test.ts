import { beforeEach, describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import {
  changeFor,
  changeText,
  evalGraph,
  hasRetriever,
  metrics,
  metricsByTag,
  percent,
  piecesWarning,
  pipelineLine,
  pipelineSteps,
  questionVariants,
  readPreviousEvaluation,
  reasonText,
  rerankEffect,
  rerankLine,
  scoreFinding,
  storePreviousEvaluation,
  summarize,
  type EvalPayload,
} from "./evaluate"
import type { Question } from "./goldSet"
import { e2eSampleGraph, removeNode, sampleGraph } from "./graph"
import { TEST_REGISTRY } from "./testRegistry"

const LIVE = liveRegistry as unknown as Registry
const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

const edgeSet = (g: { edges: { src: string; dst: string; port: string }[] }) => g.edges.map((e) => `${e.src}->${e.dst}:${e.port}`).sort()

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

describe("the graph an evaluation runs", () => {
  it("swaps the use case for eval and sets its top_k, leaving every other step alone", () => {
    const g = sampleGraph(LIVE, SRC)
    const ev = evalGraph(g, LIVE, 3)!
    const use = ev.nodes.find((n) => n.stage === "use_case")!
    expect(use.transform).toBe("eval")
    expect(use.config).toEqual({ top_k: 3 })
    // Everything above the use case is untouched, so its results stay cached.
    for (const stage of ["source", "parse", "clean", "chunk", "index", "query", "retrieve"]) {
      expect(ev.nodes.find((n) => n.stage === stage)).toEqual(g.nodes.find((n) => n.stage === stage))
    }
  })

  it("keeps the edge that feeds the use case, on the port eval declares", () => {
    const ev = evalGraph(e2eSampleGraph(LIVE, SRC), LIVE, 5)!
    expect(edgeSet(ev)).toContain("rerank_1->use_case:result")
  })

  it("is nothing when the registry has no eval step", () => {
    expect(evalGraph(sampleGraph(TEST_REGISTRY, SRC), TEST_REGISTRY, 5)).toBeNull()
  })

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

describe("one sweep variant per question", () => {
  const questions: Question[] = [
    { id: "a", question: "What are the two steps?", gold_answers: ["It answers in two steps."], tags: [] },
    { id: "b", question: "How big is a chunk?", gold_answers: ["One well.", "Or the other."], tags: ["size"] },
  ]

  it("sets the question and its gold passages together, and keeps the rest of the config", () => {
    const query = { id: "query", stage: "query" as const, transform: "text", config: { text: "old", gold_answer: "", extra: 1 } }
    expect(questionVariants(query, questions)).toEqual([
      {
        transform: "text",
        config: { text: "What are the two steps?", gold_answer: "It answers in two steps.", gold_answers: ["It answers in two steps."], extra: 1 },
      },
      {
        transform: "text",
        config: { text: "How big is a chunk?", gold_answer: "One well.", gold_answers: ["One well.", "Or the other."], extra: 1 },
      },
    ])
  })

  it("sends the single gold answer as well, so a server that has only that field still scores the run", () => {
    const query = { id: "query", stage: "query" as const, transform: "text", config: {} }
    const [first] = questionVariants(query, [{ id: "a", question: "Q", gold_answers: [], tags: [] }])
    expect(first.config).toEqual({ text: "Q", gold_answer: "", gold_answers: [] })
  })
})

describe("the metrics", () => {
  it("is empty before anything has been scored", () => {
    expect(metrics([undefined, undefined])).toMatchObject({ total: 2, scored: 0, hits: 0, hitRate: null, mrr: null, spread: [] })
  })

  it("has hit rate at k as the headline, over the questions that have finished", () => {
    const m = metrics([payload({ rank: 1 }), payload({ rank: 2 }), miss(), undefined])
    expect(m.total).toBe(4)
    expect(m.scored).toBe(3)
    expect(m.hits).toBe(2)
    expect(m.hitRate).toBeCloseTo(2 / 3)
  })

  it("averages the reciprocal rank, so finding it first beats finding it fifth, and a miss scores nothing", () => {
    expect(metrics([payload({ rank: 1 }), payload({ rank: 5 }), miss()]).mrr).toBeCloseTo((1 + 0.2 + 0) / 3)
    expect(metrics([payload({ rank: 1 }), payload({ rank: 1 })]).mrr).toBe(1)
  })

  it("reports recall at k only when some question has more than one gold passage", () => {
    const single = metrics([payload({ golds_total: 1, golds_found: 1 }), miss({ golds_total: 1, golds_found: 0 })])
    expect(single).toMatchObject({ multiGold: false, recall: null })
    const several = metrics([payload({ golds_total: 3, golds_found: 2 }), payload({ golds_total: 1, golds_found: 1 })])
    expect(several.multiGold).toBe(true)
    expect(several.recall).toBeCloseTo(3 / 4)
  })

  it("reports no recall at all when the server sent no gold counts", () => {
    expect(metrics([payload(), payload()])).toMatchObject({ multiGold: false, recall: null })
  })

  it("gives the rank of the first hit, its middle and its spread, counting only the questions that hit", () => {
    const m = metrics([payload({ rank: 1 }), payload({ rank: 1 }), payload({ rank: 4 }), miss()])
    expect(m.meanRank).toBe(2)
    expect(m.medianRank).toBe(1)
    expect(m.spread).toEqual([
      { rank: 1, count: 2 },
      { rank: 4, count: 1 },
    ])
  })

  it("takes the middle of two middle ranks", () => {
    expect(metrics([payload({ rank: 2 }), payload({ rank: 5 })]).medianRank).toBe(3.5)
  })

  it("has no rank at all when nothing was found", () => {
    expect(metrics([miss(), miss()])).toMatchObject({ meanRank: null, medianRank: null, spread: [] })
  })

  it("reads a rate as a whole percentage, and says nothing when there is no rate", () => {
    expect(percent(0.9)).toBe("90%")
    expect(percent(2 / 3)).toBe("67%")
    expect(percent(null)).toBeNull()
  })
})

describe("the metrics per tag", () => {
  const tagged = (tags: string[], p?: EvalPayload) => ({ tags, payload: p })

  it("is empty when no question carries a tag, so the page shows nothing", () => {
    expect(metricsByTag([tagged([], payload()), tagged([], miss())])).toEqual([])
  })

  it("scores each tag over its own questions, and counts a question under every tag it carries", () => {
    const rows = [
      tagged(["policy"], payload({ rank: 1 })),
      tagged(["policy", "refunds"], miss()),
      tagged(["refunds"], payload({ rank: 2 })),
    ]
    const byTag = metricsByTag(rows)
    expect(byTag.map((t) => t.tag)).toEqual(["policy", "refunds"])
    expect(byTag[0].metrics).toMatchObject({ total: 2, hits: 1, hitRate: 0.5 })
    expect(byTag[1].metrics).toMatchObject({ total: 2, hits: 1, hitRate: 0.5 })
  })

  it("names the tags in the same order every run", () => {
    const rows = [tagged(["zeta"], payload()), tagged(["alpha"], payload()), tagged(["mid"], miss())]
    expect(metricsByTag(rows).map((t) => t.tag)).toEqual(["alpha", "mid", "zeta"])
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
    expect(reasonText(pay(true, 1), 5)).toBe("Found in the 1st piece.")
    expect(reasonText(pay(true, 2, { match: "normalized" }), 5)).toBe("Found in the 2nd piece. The match ignores case and spacing.")
    expect(reasonText(pay(false, null, { found_at: 7 }), 5)).toBe("Found 7th, below the 5 pieces checked.")
    expect(reasonText(pay(false, null, { returned: 6 }), 5)).toBe("Not in any of the 6 pieces that came back, so no number of pieces checked would find it.")
  })

  it("falls back to what was checked on an older payload without the returned count", () => {
    expect(reasonText(miss({ considered: 5, total_candidates: 12 }), 5)).toBe("5 of 12 checked")
  })
})

describe("the summary", () => {
  it("counts the questions that found the answer and averages the rank they found it at", () => {
    const s = summarize([payload({ rank: 1 }), payload({ rank: 4 }), miss()])
    expect(s).toEqual({ hits: 2, total: 3, averageRank: 2.5 })
  })

  it("has no average rank when nothing was found", () => {
    expect(summarize([miss(), miss()])).toEqual({ hits: 0, total: 2, averageRank: null })
  })

  it("counts a question that has not finished in the total but not in the hits", () => {
    expect(summarize([payload(), undefined, undefined])).toEqual({ hits: 1, total: 3, averageRank: 1 })
  })

})

describe("the score as a finding", () => {
  const prev = (over: Record<string, unknown> = {}) => ({
    sourceSha: "s",
    pipelineKey: "working",
    byId: {},
    summary: { hits: 5, total: 5, averageRank: 1 },
    steps: steps("docling", "Docling"),
    ...over,
  })

  it("says the score and the last run's score as one finding", () => {
    const now = [pay(true, 1), pay(true, 1), pay(false, null), pay(false, null), pay(true, 1)]
    const before = prev()
    // Every question was found 1st last time, so both misses are losses.
    const f = scoreFinding(summarize(now), before, now.map((p) => ({ now: p, before: pay(true, 1) })), steps("pdfium", "Fast text"), 5)
    expect(f.finding).toBe("3 of 5 questions found the answer. The last run found 5 of 5.")
    expect(f.sub).toBe("Hit rate at 5 pieces: 60%. Both misses are new since Parse changed to Fast text.")
  })

  it("says every answer came back first on a clean first run", () => {
    const now = [pay(true, 1), pay(true, 1)]
    const f = scoreFinding(summarize(now), null, now.map((p) => ({ now: p })), steps("docling", "Docling"), 5)
    expect(f.finding).toBe("2 of 2 questions found the answer.")
    expect(f.sub).toBe("Hit rate at 5 pieces: 100%. Every answer came back as the top piece.")
  })

  it("counts the new misses, and says since the last run when no single step changed", () => {
    const one = [pay(true, 1), pay(false, null)]
    expect(scoreFinding(summarize(one), prev({ steps: undefined }), one.map((p) => ({ now: p, before: pay(true, 1) })), steps("pdfium", "Fast text"), 5).sub).toBe(
      "Hit rate at 5 pieces: 50%. The miss is new since the last run.",
    )
    const three = [pay(false, null), pay(false, null), pay(false, null)]
    expect(scoreFinding(summarize(three), prev(), three.map((p) => ({ now: p, before: pay(true, 2) })), steps("docling", "Docling"), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. All 3 misses are new since the last run.",
    )
    const some = three.map((p, i) => ({ now: p, before: i === 2 ? pay(false, null) : pay(true, 1) }))
    expect(scoreFinding(summarize(three), prev(), some, steps("pdfium", "Fast text"), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. 2 of the 3 misses are new since Parse changed to Fast text.",
    )
  })

  it("names a change only when exactly one step's transform differs", () => {
    const now = [pay(false, null)]
    const two = [
      { label: "Parse", transform: "pdfium", name: "Fast text" },
      { label: "Chunk", transform: "token_based", name: "Fixed token count" },
    ]
    expect(scoreFinding(summarize(now), prev(), [{ now: now[0], before: pay(true, 1) }], two, 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since the last run.",
    )
  })

  it("says piece, not pieces, when one is checked", () => {
    expect(scoreFinding(summarize([pay(true, 2)]), null, [{ now: pay(true, 2) }], steps("docling", "Docling"), 1).sub).toBe("Hit rate at 1 piece: 100%.")
  })

  it("names a step only when its settings are the one change, and the pieces checked did not change", () => {
    const now = [pay(false, null)]
    const rows = [{ now: now[0], before: pay(true, 1) }]
    const withConfig = (parse: string, name: string, size: number) => [
      { label: "Parse", transform: parse, name, config: "{}" },
      { label: "Chunk", transform: "recursive_character", name: "Recursive (natural breaks)", config: JSON.stringify({ chunk_size: size }) },
    ]
    const before = prev({ steps: withConfig("docling", "Docling", 400), k: 5 })
    expect(scoreFinding(summarize(now), before, rows, withConfig("pdfium", "Fast text", 400), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since Parse changed to Fast text.",
    )
    // The chunk size changed in the same trip to Build, so Parse alone is not the cause.
    expect(scoreFinding(summarize(now), before, rows, withConfig("pdfium", "Fast text", 200), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since the last run.",
    )
    // Only a setting changed, so the step is named without a new name.
    expect(scoreFinding(summarize(now), before, rows, withConfig("docling", "Docling", 200), 5).sub).toBe(
      "Hit rate at 5 pieces: 0%. The miss is new since Chunk's settings changed.",
    )
    // Pieces checked changed between the runs.
    expect(scoreFinding(summarize(now), before, rows, withConfig("pdfium", "Fast text", 400), 3).sub).toBe(
      "Hit rate at 3 pieces: 0%. The miss is new since the last run.",
    )
  })

  it("says nothing more when the misses are old, or the hits are not all first", () => {
    const now = [pay(true, 2), pay(false, null)]
    expect(scoreFinding(summarize(now), prev(), now.map((p) => ({ now: p, before: p })), steps("docling", "Docling"), 5).sub).toBe("Hit rate at 5 pieces: 50%.")
    expect(scoreFinding(summarize([pay(true, 2)]), null, [{ now: pay(true, 2) }], steps("docling", "Docling"), 3)).toEqual({
      finding: "1 of 1 question found the answer.",
      sub: "Hit rate at 3 pieces: 100%.",
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
        "s|working": { sourceSha: "s", pipelineKey: "working", byId: {}, summary: { hits: 1, total: 2, averageRank: 1 } },
      }),
    )
    expect(readPreviousEvaluation("s", "working")?.summary.hits).toBe(1)
    expect(readPreviousEvaluation("s", "working")?.steps).toBeUndefined()
  })

  it("keeps the recipe it was scored with", () => {
    storePreviousEvaluation({ sourceSha: "s", pipelineKey: "working", byId: {}, summary: { hits: 1, total: 2, averageRank: 1 }, steps: steps("docling", "Docling") })
    expect(readPreviousEvaluation("s", "working")?.steps).toEqual(steps("docling", "Docling"))
  })

  const SHA = "cd".repeat(32)
  const OTHER_SHA = "ab".repeat(32)

  beforeEach(() => window.sessionStorage.clear())

  it("is nothing before the first run", () => {
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("comes back as it went in, so a trip to Build and back keeps it, for the same document and pipeline", () => {
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, summary: summarize([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(SHA, "working")).toEqual(before)
  })

  it("is ignored when it was recorded against a different document (F5)", () => {
    // Score the primer, load Scanned notes, evaluate: the primer's "10 of 10"
    // must not be compared against Scanned notes' own run.
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, summary: summarize([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(OTHER_SHA, "working")).toBeNull()
  })

  it("is ignored when it was recorded against a different pipeline", () => {
    // Stored for the saved pipeline "working" carries a run scored with a
    // different pipeline: the score under "abc" must not borrow it.
    const before = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, summary: summarize([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation(SHA, "abc")).toBeNull()
  })

  it("treats a stored result with no pipelineKey (old shape) as none", () => {
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify({ sourceSha: SHA, byId: {}, summary: summarize([]) }))
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("keeps one previous score per pipeline, so scoring A, then B, then A again still finds A's (I2)", () => {
    const a = { sourceSha: SHA, pipelineKey: "A", byId: { a: payload({ rank: 1 }) }, summary: summarize([payload()]) }
    const b = { sourceSha: SHA, pipelineKey: "B", byId: { a: payload({ rank: 4 }) }, summary: summarize([miss()]) }
    storePreviousEvaluation(a)
    storePreviousEvaluation(b)
    expect(readPreviousEvaluation(SHA, "A")).toEqual(a)
    expect(readPreviousEvaluation(SHA, "B")).toEqual(b)
  })

  it("treats the old single-slot shape as none, even for its own document and pipeline", () => {
    const old = { sourceSha: SHA, pipelineKey: "working", byId: { a: payload({ rank: 3 }) }, summary: summarize([payload()]) }
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify(old))
    expect(readPreviousEvaluation(SHA, "working")).toBeNull()
  })

  it("keeps at most 40 scores, dropping the oldest", () => {
    const one = (k: string) => ({ sourceSha: SHA, pipelineKey: k, byId: {}, summary: summarize([]) })
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
