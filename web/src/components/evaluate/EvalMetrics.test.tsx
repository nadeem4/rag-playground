import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { EvalPayload } from "@/api/types"
import { metrics, metricsByTag } from "@/state/evaluate"

import { EvalMetricsDetail } from "./EvalMetrics"

function payload(over: Partial<EvalPayload> = {}): EvalPayload {
  return {
    question: "Why do chunk boundaries matter?",
    gold_answer: "A chunk should answer one question well.",
    hit: true,
    rank: 1,
    matched_chunk_id: "c1",
    match: "exact",
    considered: 5,
    total_candidates: 20,
    ...over,
  }
}

const show = (rows: { tags: string[]; payload?: EvalPayload }[], rerank: string | null = null) =>
  render(
    <EvalMetricsDetail
      metrics={metrics(rows.map((r) => r.payload))}
      byTag={metricsByTag(rows)}
      topK={5}
      rerank={rerank}
    />,
  )

afterEach(cleanup)

describe("the numbers behind the headline", () => {
  it("always gives the mean reciprocal rank and the rank of the first hit", () => {
    show([{ tags: [], payload: payload({ rank: 1 }) }, { tags: [], payload: payload({ rank: 3 }) }])
    expect(screen.getByTestId("average-rank").textContent).toMatch(/Average rank of the first hit2\.0/)
    expect(document.body.textContent).toMatch(/Mean reciprocal rank0\.67/)
    expect(screen.getByTestId("rank-spread").textContent).toMatch(/rank 11rank 31/)
  })

  it("leaves recall out when every question has one gold passage", () => {
    show([{ tags: [], payload: payload({ golds_total: 1, golds_found: 1 }) }])
    expect(document.body.textContent).not.toMatch(/Recall/)
  })

  it("shows recall at k when a question has more than one gold passage", () => {
    show([
      { tags: [], payload: payload({ golds_total: 3, golds_found: 2 }) },
      { tags: [], payload: payload({ golds_total: 1, golds_found: 1 }) },
    ])
    expect(document.body.textContent).toMatch(/Recall at 575%/)
    expect(document.body.textContent).toMatch(/3 of 4 gold passages were in the top 5/)
  })

  it("leaves the per-tag table out when the set has no tags", () => {
    show([{ tags: [], payload: payload() }])
    expect(screen.queryByTestId("by-tag")).toBeNull()
  })

  it("scores each tag when the set has tags", () => {
    show([
      { tags: ["policy"], payload: payload({ rank: 1 }) },
      { tags: ["policy"], payload: payload({ hit: false, rank: null }) },
      { tags: ["refunds"], payload: payload({ rank: 2 }) },
    ])
    const table = screen.getByTestId("by-tag")
    expect(table.textContent).toMatch(/policy1\/250%/)
    expect(table.textContent).toMatch(/refunds1\/1100%/)
  })

  it("says what is not known yet rather than showing a zero", () => {
    show([{ tags: [], payload: undefined }])
    expect(document.body.textContent).toMatch(/not yet/)
  })

  it("carries the reranker's line when there is a reranker, and has no em-dashes or en-dashes", () => {
    show([{ tags: [], payload: payload() }], "Rerank moved the answer up for 1 of the 1 questions that found it, and down for 0.")
    expect(screen.getByTestId("rerank-effect").textContent).toMatch(/Rerank moved the answer up/)
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})
