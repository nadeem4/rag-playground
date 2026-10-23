import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { BestRun, Outcome } from "@/state/best"

import { BestSoFar } from "./BestSoFar"

afterEach(cleanup)

const BEST = { found: 2, scored: 2, hit_rate: 1, mrr: 1, name: "Best one", at: "2026-10-16T21:40:00.000Z" } as BestRun
const NOTE = "llm_rerank can give a different result each run, so a newly missed question may be noise."
const noop = () => undefined

function show(outcome: Outcome) {
  render(<BestSoFar outcome={outcome} problem={null} onLoad={noop} compare={<p>The panel</p>} onForget={noop} />)
}

describe("BestSoFar", () => {
  it.each<Outcome>([
    { kind: "worse", best: BEST, fewer: 1, tie: false, lost: ["Why?"], notes: [NOTE] },
    { kind: "better", before: BEST, more: 1, tie: false, won: ["Why?"], lost: [], notes: [NOTE] },
    { kind: "equal", best: BEST, found: 2, scored: 2, notes: [NOTE] },
  ])("shows Pandion's notes on the comparison ($kind)", (outcome) => {
    show(outcome)
    expect(screen.getByRole("list", { name: "About this comparison" }).textContent).toBe(NOTE)
  })

  it("shows no notes list when Pandion has none", () => {
    show({ kind: "equal", best: BEST, found: 2, scored: 2, notes: [] })
    expect(screen.queryByTestId("best-notes")).toBeNull()
  })

  it.each<Outcome>([
    { kind: "worse", best: BEST, fewer: 1, tie: false, lost: ["Why?"], notes: [] },
    { kind: "better", before: BEST, more: 1, tie: false, won: ["Why?"], lost: [], notes: [] },
  ])("opens Compare the two in place and closes it again ($kind)", (outcome) => {
    show(outcome)
    const button = screen.getByRole("button", { name: "Compare the two" })
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("The panel")).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("The panel").closest("[id]")!.id).toBe(button.getAttribute("aria-controls"))
    fireEvent.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    // Kept, only hidden, so opening it again does not run the best pipeline again.
    expect((screen.getByText("The panel").closest("[id]") as HTMLElement).hidden).toBe(true)
  })

  it("names the questions a better run lost as well as those it won", () => {
    show({ kind: "better", before: BEST, more: 1, tie: false, won: ["Why?", "How?"], lost: ["Who?"], notes: [] })
    const box = screen.getByTestId("best-so-far")
    expect(within(box).getByRole("list", { name: "Won since your best" }).textContent).toBe("wonWhy?wonHow?")
    expect(within(box).getByRole("list", { name: "Lost since your best" }).textContent).toBe("lostWho?")
  })
})
