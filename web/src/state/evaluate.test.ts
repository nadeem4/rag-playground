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
  pipelineSteps,
  questionVariants,
  readPreviousEvaluation,
  rerankEffect,
  rerankLine,
  storePreviousEvaluation,
  summarize,
  summaryLine,
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

  it("names the steps being evaluated, in column order", () => {
    expect(pipelineSteps(e2eSampleGraph(LIVE, SRC))).toEqual([
      { label: "Parse", transform: "docling" },
      { label: "Clean", transform: "dedupe_blocks" },
      { label: "Chunk", transform: "recursive_character" },
      { label: "Index", transform: "lancedb" },
      { label: "Retrieve", transform: "hybrid_rrf" },
      { label: "Rerank", transform: "mmr" },
    ])
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

  it("reads as a sentence, with the previous run beside it", () => {
    const now = summarize([payload(), payload(), miss()])
    const before = summarize([payload(), miss(), miss()])
    expect(summaryLine(now)).toBe("2 of 3 found the answer")
    expect(summaryLine(now, before)).toBe("2 of 3 found the answer, was 1 of 3")
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
    expect(changeText("found", miss())).toBe("was a miss")
    expect(changeText("lost", payload({ rank: 2 }))).toBe("was rank 2")
    expect(changeText("up", payload({ rank: 5 }))).toBe("was rank 5")
    expect(changeText("none", payload())).toBeNull()
  })
})

describe("the previous evaluation of the session", () => {
  beforeEach(() => window.sessionStorage.clear())

  it("is nothing before the first run", () => {
    expect(readPreviousEvaluation()).toBeNull()
  })

  it("comes back as it went in, so a trip to Build and back keeps it", () => {
    const before = { byId: { a: payload({ rank: 3 }) }, summary: summarize([payload(), miss()]) }
    storePreviousEvaluation(before)
    expect(readPreviousEvaluation()).toEqual(before)
  })

  it("is nothing when the stored value is not an evaluation", () => {
    window.sessionStorage.setItem("rag-playground:evaluation:previous", "{oops")
    expect(readPreviousEvaluation()).toBeNull()
    window.sessionStorage.setItem("rag-playground:evaluation:previous", JSON.stringify({ byId: 7 }))
    expect(readPreviousEvaluation()).toBeNull()
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
