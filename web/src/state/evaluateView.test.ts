import { describe, expect, it } from "vitest"

import type { EvalPayload, Registry } from "@/api/types"
import type { NodeState } from "@/api/runState"
import liveRegistry from "@/api/fixtures/registry.json"

import { metrics } from "./evaluate"
import { indexLine, indexSteps, numbersRow, progressLine, searchSteps, staleLine, evidenceCells } from "./evaluateView"
import { sampleGraph, setConfig, setTransform } from "./graph"

const registry = liveRegistry as unknown as Registry

function pay(hit: boolean, rank: number | null, over: Partial<EvalPayload> = {}): EvalPayload {
  return {
    question: "q",
    gold_answer: "g",
    hit,
    rank,
    matched_chunk_id: hit ? "c" : "",
    match: hit ? "exact" : "none",
    golds_total: 1,
    golds_found: hit ? 1 : 0,
    considered: 5,
    total_candidates: 10,
    found_at: null,
    returned: 10,
    ...over,
  } as EvalPayload
}

const state = (status: NodeState["status"], id = "x"): NodeState => ({ id, status })

describe("numbersRow", () => {
  it("names each number with its technical name and the k it was scored at", () => {
    const row = numbersRow(metrics([pay(true, 1), pay(true, 2), pay(false, null), pay(true, 3)]), null, 5)
    expect(row.map((n) => n.label)).toEqual([
      "Hit rate (Hit@5)",
      "Mean reciprocal rank (MRR)",
      "Average rank when found (mean rank)",
      "Middle rank when found (median rank)",
    ])
    expect(row.map((n) => n.value)).toEqual(["75%", "0.46", "2.0", "2"])
    expect(row.every((n) => n.was === null)).toBe(true)
  })

  it("adds recall only when a question has more than one passage", () => {
    const row = numbersRow(metrics([pay(true, 1, { golds_total: 2, golds_found: 1 })]), null, 5)
    expect(row.map((n) => n.label)).toContain("Evidence found (recall at 5)")
    expect(row.find((n) => n.label.startsWith("Evidence"))!.value).toBe("50%")
  })

  it("says what each number was when the last run differs, and nothing when it is the same", () => {
    const now = metrics([pay(true, 1), pay(true, 1)])
    const before = metrics([pay(true, 1), pay(false, null)])
    const row = numbersRow(now, before, 5)
    expect(row[0]).toMatchObject({ value: "100%", was: "50%" })
    expect(row[2]).toMatchObject({ value: "1.0", was: null })
  })

  it("says none when nothing was found, rather than a number", () => {
    const row = numbersRow(metrics([pay(false, null)]), null, 5)
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
