import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { RetrievalResult } from "@/api/types"
import { rowsFromResult } from "@/components/inspectors/hits"

import { GuideAskResults } from "./GuideAskResults"

afterEach(cleanup)

const candidates = rowsFromResult(hybridJson as unknown as RetrievalResult)
const QUESTION = "What three things decide a good chunk size for a collection?"
const marked = () => [...document.querySelectorAll<HTMLElement>("[data-answer]")]
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-guide-row]")]

describe("GuideAskResults", () => {
  it("pins the question and draws one row per candidate with rank, text and score", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={5} found={null} />)
    expect(screen.getByTestId("guide-question").textContent).toBe(QUESTION)
    expect(rows()).toHaveLength(candidates.length)
    expect(rows()[0].textContent).toContain("1")
    expect(rows()[0].textContent).toContain(candidates[0].text.slice(0, 20))
    expect(rows()[0].textContent).toContain(candidates[0].score.toPrecision(4))
  })

  it("marks the row at found.rank", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={5} found={{ rank: 3 }} />)
    expect(marked()).toHaveLength(1)
    expect(marked()[0]).toBe(rows()[2])
  })

  it("marks no row when the answer was not found", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={5} found={null} />)
    expect(marked()).toHaveLength(0)
  })

  it("draws the dashed line once, after row `shown`", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={5} found={{ rank: 6 }} />)
    const line = screen.getAllByTestId("guide-line")
    expect(line).toHaveLength(1)
    expect(line[0].textContent).toBe("The answer step reads only the 5 above this line.")
    expect(rows()[4].compareDocumentPosition(line[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line[0].compareDocumentPosition(rows()[5]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("still shows the line when the answer is inside the shown rows", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={5} found={{ rank: 2 }} />)
    expect(screen.getAllByTestId("guide-line")).toHaveLength(1)
  })

  it("draws no line when nothing is below it", () => {
    render(<GuideAskResults question={QUESTION} candidates={candidates} shown={candidates.length} found={null} />)
    expect(screen.queryByTestId("guide-line")).toBeNull()
  })
})
