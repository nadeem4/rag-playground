import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Totals } from "@/api/types"

import { EvalNumbers } from "./EvalMetrics"

/** The server's totals, as /api/v2/evaluations returns them. The page adds nothing up. */
function totals(over: Partial<Totals> = {}): Totals {
  return { total: 2, scored: 2, found: 1, hit_rate: 0.5, mrr: 0.5, recall: null, mean_rank: 1, median_rank: 1, ...over }
}

const show = (
  now: Totals,
  {
    before = null,
    byTag = {},
    rerank = null,
    onExplain = () => {},
  }: { before?: Totals | null; byTag?: Record<string, Totals>; rerank?: string | null; onExplain?: () => void } = {},
) => render(<EvalNumbers totals={now} before={before} byTag={byTag} topK={5} rerank={rerank} onExplain={onExplain} />)

afterEach(cleanup)

describe("the numbers row", () => {
  it("shows every number at once, each with its technical name", () => {
    show(totals())
    const row = screen.getByTestId("numbers")
    expect(row.tagName).toBe("DL")
    for (const label of ["Hit rate (Hit@5)", "Mean reciprocal rank (MRR)", "Average rank when found (mean rank)", "Middle rank when found (median rank)"]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByText("50%")).toBeTruthy()
    expect(screen.getByText("0.50")).toBeTruthy()
  })

  it("says what a number was when the last run differs", () => {
    show(totals({ found: 2, hit_rate: 1 }), { before: totals({ found: 0, hit_rate: 0 }) })
    expect(screen.getByText("was 0%")).toBeTruthy()
  })

  it("adds recall only when the server sends one", () => {
    show(totals())
    expect(screen.queryByText(/recall at 5/)).toBeNull()
    cleanup()
    show(totals({ recall: 0.5 }))
    expect(screen.getByText("Evidence found (recall at 5)")).toBeTruthy()
  })

  it("says the server's count per tag in one line, only when there are tags", () => {
    show(totals())
    expect(screen.queryByTestId("by-tag")).toBeNull()
    cleanup()
    show(totals(), {
      byTag: {
        sentence: totals({ total: 1, scored: 1, found: 1, hit_rate: 1 }),
        "table row": totals({ total: 2, scored: 2, found: 1 }),
      },
    })
    expect(screen.getByTestId("by-tag").textContent).toContain("By tag: sentence 1 of 1 found, table row 1 of 2 found.")
  })

  it("keeps the reranker's line, and opens the explanation from What these mean", () => {
    const onExplain = vi.fn()
    show(totals(), { rerank: "The reranker moved 1 answer up.", onExplain })
    expect(screen.getByTestId("rerank-effect").textContent).toBe("The reranker moved 1 answer up.")
    fireEvent.click(screen.getByRole("button", { name: "What these mean" }))
    expect(onExplain).toHaveBeenCalled()
  })
})
