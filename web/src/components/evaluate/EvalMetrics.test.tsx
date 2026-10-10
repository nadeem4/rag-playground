import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { EvalPayload } from "@/api/types"
import { metrics, metricsByTag } from "@/state/evaluate"

import { EvalNumbers } from "./EvalMetrics"

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

const show = (
  rows: { tags: string[]; payload?: EvalPayload }[],
  { before = null, rerank = null, onExplain = () => {} }: { before?: (EvalPayload | undefined)[] | null; rerank?: string | null; onExplain?: () => void } = {},
) =>
  render(
    <EvalNumbers
      metrics={metrics(rows.map((r) => r.payload))}
      before={before ? metrics(before) : null}
      byTag={metricsByTag(rows)}
      topK={5}
      rerank={rerank}
      onExplain={onExplain}
    />,
  )

afterEach(cleanup)

describe("the numbers row", () => {
  it("shows every number at once, each with its technical name", () => {
    show([{ tags: [], payload: payload() }, { tags: [], payload: payload({ hit: false, rank: null }) }])
    const row = screen.getByTestId("numbers")
    expect(row.tagName).toBe("DL")
    for (const label of ["Hit rate (Hit@5)", "Mean reciprocal rank (MRR)", "Average rank when found (mean rank)", "Middle rank when found (median rank)"]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByText("50%")).toBeTruthy()
    expect(screen.getByText("0.50")).toBeTruthy()
  })

  it("says what a number was when the last run differs", () => {
    show([{ tags: [], payload: payload() }], { before: [payload({ hit: false, rank: null })] })
    expect(screen.getByText("was 0%")).toBeTruthy()
  })

  it("adds recall only when a question has more than one passage", () => {
    show([{ tags: [], payload: payload() }])
    expect(screen.queryByText(/recall at 5/)).toBeNull()
    cleanup()
    show([{ tags: [], payload: payload({ golds_total: 2, golds_found: 1 }) }])
    expect(screen.getByText("Evidence found (recall at 5)")).toBeTruthy()
  })

  it("says the hit rate per tag in one line, only when there are tags", () => {
    show([{ tags: [], payload: payload() }])
    expect(screen.queryByTestId("by-tag")).toBeNull()
    cleanup()
    show([
      { tags: ["table row"], payload: payload() },
      { tags: ["table row"], payload: payload({ hit: false, rank: null }) },
      { tags: ["sentence"], payload: payload() },
    ])
    expect(screen.getByTestId("by-tag").textContent).toContain("By tag: sentence 1 of 1 found, table row 1 of 2 found.")
  })

  it("keeps the reranker's line, and opens the explanation from What these mean", () => {
    const onExplain = vi.fn()
    show([{ tags: [], payload: payload() }], { rerank: "The reranker moved 1 answer up.", onExplain })
    expect(screen.getByTestId("rerank-effect").textContent).toBe("The reranker moved 1 answer up.")
    fireEvent.click(screen.getByRole("button", { name: "What these mean" }))
    expect(onExplain).toHaveBeenCalled()
  })
})
