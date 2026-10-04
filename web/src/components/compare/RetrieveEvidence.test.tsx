import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { RetrievalResult } from "@/api/types"
import { rowsFromResult } from "@/components/inspectors/hits"

import { RetrieveEvidence } from "./RetrieveEvidence"

afterEach(cleanup)

const rows = rowsFromResult(hybridJson as unknown as RetrievalResult)

describe("RetrieveEvidence", () => {
  it("opens with the agreement sentence in semibold, then the slips, with no facts strip", () => {
    render(<RetrieveEvidence rows={rows} agreement="Same 5 pieces. The 2nd and 3rd swap places." answer={null} />)
    const line = screen.getByTestId("agreement")
    expect(line.textContent).toBe("Same 5 pieces. The 2nd and 3rd swap places.")
    expect(line.className).toContain("font-semibold")
    expect(screen.getAllByTestId("passage")).toHaveLength(rows.length)
    expect(document.querySelector("[data-summary]")).toBeNull()
    expect(screen.queryByTestId("fact-hits")).toBeNull()
    expect(document.querySelector("[data-reading]")).toBeNull()
  })

  it("says the slip that holds the answer holds it", () => {
    render(<RetrieveEvidence rows={rows} agreement={null} answer={rows[0].chunk_id} />)
    const findings = screen.getAllByTestId("finding").map((f) => f.textContent)
    expect(findings[0]).toBe("1st, holds the answer")
    expect(findings.slice(1).some((f) => f?.includes("answer"))).toBe(false)
  })

  it("never says the answer when it is not known", () => {
    render(<RetrieveEvidence rows={rows} agreement={null} answer={null} />)
    for (const f of screen.getAllByTestId("finding")) expect(f.textContent).not.toMatch(/answer/)
  })
})
