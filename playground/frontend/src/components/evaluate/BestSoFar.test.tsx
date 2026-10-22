import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { BestRun, Outcome } from "@/state/best"

import { BestSoFar } from "./BestSoFar"

afterEach(cleanup)

const BEST = { found: 2, scored: 2, hit_rate: 1, mrr: 1, name: "Best one", at: "2026-10-16T21:40:00.000Z" } as BestRun
const NOTE = "llm_rerank can give a different result each run, so a newly missed question may be noise."
const noop = () => undefined

function show(outcome: Outcome) {
  render(<BestSoFar outcome={outcome} problem={null} onLoad={noop} onCompare={noop} onForget={noop} />)
}

describe("BestSoFar", () => {
  it.each<Outcome>([
    { kind: "worse", best: BEST, fewer: 1, tie: false, lost: ["Why?"], notes: [NOTE] },
    { kind: "better", before: BEST, more: 1, tie: false, won: ["Why?"], notes: [NOTE] },
    { kind: "equal", best: BEST, found: 2, scored: 2, notes: [NOTE] },
  ])("shows Pandion's notes on the comparison ($kind)", (outcome) => {
    show(outcome)
    expect(screen.getByRole("list", { name: "About this comparison" }).textContent).toBe(NOTE)
  })

  it("shows no notes list when Pandion has none", () => {
    show({ kind: "equal", best: BEST, found: 2, scored: 2, notes: [] })
    expect(screen.queryByTestId("best-notes")).toBeNull()
  })
})
