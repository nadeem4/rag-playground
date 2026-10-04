import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { RetrievalResult } from "@/api/types"

import { EvidenceSlip } from "./EvidenceSlip"
import { rowsFromResult, type HitRowData } from "./hits"

const hybrid = hybridJson as unknown as RetrievalResult
const rows = rowsFromResult(hybrid)

afterEach(cleanup)

const slip = () => document.querySelector<HTMLElement>("[data-slip]")!
const part = (name: string) => slip().querySelector<HTMLElement>(`[data-testid=${name}]`)

describe("the evidence slip", () => {
  it("has a swatch, a finding line, the passage and a meta line", () => {
    render(<EvidenceSlip row={rows[0]} side="single" piece={2} scaleKey="hybrid_rrf" />)
    const sw = screen.getByRole("img", { name: "Chunk 3" })
    expect(sw.textContent).toBe("3")
    expect(sw.dataset.id).toBe(rows[0].chunk_id)
    expect(sw.className).toContain("rounded-swatch")
    expect(sw.className).toContain("bg-chunk-3")
    expect(sw.className).toContain("text-chunk-3-text")
    expect(part("finding")!.textContent).toBe("1st")
    expect(part("passage")!.textContent).toBe(rows[0].text)
    expect(part("meta")!.className).toMatch(/\btext-xs\b/)
    expect(part("meta")!.className).toContain("text-fg-muted")
    // The slip itself: no border, a 12 px radius, 44 px tall at least, and it lights on hover or focus.
    const c = slip().className
    expect(c).toContain("rounded-panel")
    expect(c).toContain("min-h-[44px]")
    expect(c).toContain("p-[10px_12px]")
    expect(c).not.toMatch(/(^|\s)border(-b)?(\s|$)/)
    expect(c).toContain("hover:bg-surface-raised")
    expect(c).toContain("focus-within:bg-surface-raised")
    expect(c).toContain("focus-visible:bg-surface-raised")
    expect(c).toContain("focus-visible:ring-hairline")
    // A keyboard reaches it.
    expect(slip().tabIndex).toBe(0)
    expect(c).toContain("hover:ring-hairline")
  })

  it("a compact slip clamps its passage and has Show more on its meta line, which opens and closes it in place", () => {
    const onClick = vi.fn()
    render(<EvidenceSlip row={rows[0]} side="reranked" piece={0} scaleKey="hybrid_rrf" compact onClick={onClick} />)
    expect(part("passage")!.className).toContain("line-clamp-2")
    const more = within(part("meta")!).getByRole("button", { name: "Show more" })
    expect(more.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(more)
    expect(part("passage")!.className).not.toContain("line-clamp")
    const less = within(part("meta")!).getByRole("button", { name: "Show less" })
    expect(less.getAttribute("aria-expanded")).toBe("true")
    // The toggle is its own control: it does not select the slip.
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.click(less)
    expect(part("passage")!.className).toContain("line-clamp-2")
  })

  it("a slip that is not compact has no Show more", () => {
    render(<EvidenceSlip row={rows[0]} side="reranked" piece={0} scaleKey="hybrid_rrf" />)
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
  })

  it("a lit slip has the raised look of a hovered one", () => {
    const { rerender } = render(<EvidenceSlip row={rows[0]} side="search" piece={0} scaleKey="hybrid_rrf" />)
    expect(slip().hasAttribute("data-lit")).toBe(false)
    expect(slip().className).not.toMatch(/(^|\s)bg-surface-raised(\s|$)/)
    rerender(<EvidenceSlip row={rows[0]} side="search" piece={0} scaleKey="hybrid_rrf" lit />)
    expect(slip().hasAttribute("data-lit")).toBe(true)
    expect(slip().className).toMatch(/(^|\s)bg-surface-raised(\s|$)/)
    expect(slip().className).toMatch(/(^|\s)ring-1(\s|$)/)
    expect(slip().className).toMatch(/(^|\s)ring-hairline(\s|$)/)
  })

  it("sets the passage in the document voice and the finding line in the tool's voice, on every side", () => {
    for (const side of ["single", "search", "reranked", "notKept"] as const) {
      render(<EvidenceSlip row={{ ...rows[1], prior_rank: 4 }} side={side} piece={0} scaleKey="hybrid_rrf" keepLimit={5} />)
      const passage = part("passage")!
      expect(passage.className).toContain("font-serif")
      expect(passage.className).toMatch(/\btext-base\b/)
      expect(passage.className).toContain("leading-[1.55]")
      const finding = part("finding")!
      expect(finding.className).not.toContain("font-serif")
      expect(finding.className).toContain("font-sans")
      expect(finding.className).toMatch(/\btext-sm\b/)
      cleanup()
    }
  })

  it("clamps the passage to two lines only when asked", () => {
    const { rerender } = render(<EvidenceSlip row={rows[0]} side="search" piece={0} scaleKey="hybrid_rrf" clamp />)
    expect(part("passage")!.className).toContain("line-clamp-2")
    // A clamped passage flows as plain text: a kept blank line would eat a clamped line.
    expect(part("passage")!.className).not.toContain("whitespace-pre-line")
    rerender(<EvidenceSlip row={rows[0]} side="reranked" piece={0} scaleKey="hybrid_rrf" />)
    expect(part("passage")!.className).not.toContain("line-clamp")
    expect(part("passage")!.className).toContain("whitespace-pre-line")
  })

  it("names every score's scale beside its number, the number in mono and a miss in words", () => {
    render(<EvidenceSlip row={rows[5]} side="single" piece={0} scaleKey="hybrid_rrf" keys={["dense", "bm25"]} />)
    const scores = [...slip().querySelectorAll<HTMLElement>("[data-score]")]
    expect(scores.map((s) => s.dataset.score)).toEqual(["RRF", "Dense", "BM25"])
    expect(scores[0].textContent).toMatch(/^RRF 0\.0\d+$/)
    expect(scores[0].querySelector(".font-mono")!.textContent).toMatch(/^0\.0\d+$/)
    const miss = scores[2]
    expect(miss.textContent).toBe("BM25 no keyword match")
    expect(miss.querySelector(".font-mono")).toBeNull()
    expect(within(miss).getByText("no keyword match").className).toContain("whitespace-nowrap")
    cleanup()
    const rescored: HitRowData = { ...rows[0], score: 8.21, prior_score: 0.03, prior_rank: 3, component_scores: {} }
    render(<EvidenceSlip row={rescored} side="reranked" piece={0} scaleKey="cross_encoder" />)
    expect(slip().querySelector<HTMLElement>("[data-score]")!.textContent).toBe("Cross-encoder 8.210")
  })

  it("the search side states the fused score in the finding line, not twice", () => {
    render(<EvidenceSlip row={rows[0]} side="search" piece={0} scaleKey="hybrid_rrf" />)
    expect(part("finding")!.textContent).toBe("1st in search, RRF 0.03279")
    expect([...slip().querySelectorAll<HTMLElement>("[data-score]")].map((s) => s.dataset.score)).toEqual(["Dense", "BM25"])
  })

  it("bolds the movement when the piece rose", () => {
    render(<EvidenceSlip row={{ ...rows[0], rank: 1, prior_rank: 6 }} side="reranked" piece={0} scaleKey="cross_encoder" />)
    expect(part("finding")!.textContent).toBe("1st, moved up from 6th")
    expect(within(part("finding")!).getByText("moved up from 6th").className).toContain("font-semibold")
    // The place is set apart too.
    expect(within(part("finding")!).getByText("1st").className).toContain("font-semibold")
  })

  it("a Not kept slip is faint, says why, has no scores, and its swatch is an outline", () => {
    render(<EvidenceSlip row={{ ...rows[5], prior_rank: null }} side="notKept" piece={4} scaleKey="hybrid_rrf" keepLimit={5} />)
    expect(slip().className).toContain("opacity-75")
    expect(part("finding")!.textContent).toBe("Not kept. It was 6th in search and the keep limit is 5.")
    expect(slip().querySelectorAll("[data-score]")).toHaveLength(0)
    const sw = screen.getByRole("img", { name: "Chunk 5" })
    expect(sw.className).toContain("border-flat")
    expect(sw.className).not.toContain("bg-chunk-5")
  })

  it("shows the page and the section on the meta line", () => {
    render(<EvidenceSlip row={{ ...rows[0], section: "Methods > Survey" }} side="single" piece={0} scaleKey="hybrid_rrf" />)
    expect(part("meta")!.textContent).toContain("p. 3")
    expect(part("meta")!.textContent).toContain("Methods > Survey")
  })

  it("offers Show in PDF as the accent text button, and only with a handler", () => {
    const onShow = vi.fn()
    const { rerender } = render(<EvidenceSlip row={rows[0]} side="single" piece={0} scaleKey="hybrid_rrf" onShowInPdf={onShow} />)
    const button = screen.getByRole("button", { name: "Show in PDF" })
    expect(part("meta")!.contains(button)).toBe(true)
    expect(button.className).toContain("text-primary")
    expect(button.className).not.toMatch(/(^|\s)underline(\s|$)/)
    fireEvent.click(button)
    expect(onShow).toHaveBeenCalledTimes(1)
    rerender(<EvidenceSlip row={rows[0]} side="single" piece={0} scaleKey="hybrid_rrf" />)
    expect(screen.queryByRole("button", { name: "Show in PDF" })).toBeNull()
  })

  it("passes the motion attributes through to the slip", () => {
    render(<EvidenceSlip row={rows[0]} side="single" piece={0} scaleKey="hybrid_rrf" data-flip-key="abc" data-enter="" style={{ "--i": 2 } as React.CSSProperties} />)
    expect(slip().dataset.flipKey).toBe("abc")
    expect(slip().hasAttribute("data-enter")).toBe(true)
    expect(slip().style.getPropertyValue("--i")).toBe("2")
  })

  it("a piece outside the chunk set gets a neutral swatch", () => {
    render(<EvidenceSlip row={rows[0]} side="single" piece={null} scaleKey="hybrid_rrf" />)
    const sw = slip().querySelector<HTMLElement>("[data-id]")!
    expect(sw.className).not.toMatch(/bg-chunk-\d/)
    expect(sw.getAttribute("aria-label")).toBe("Chunk not in this chunk set")
  })

  it("a bare slip is the swatch and the passage only: no finding line and no scores", () => {
    const row: HitRowData = { ...rows[0], page_span: null, section: null }
    render(<EvidenceSlip row={row} side="single" piece={null} scaleKey="score" bare />)
    expect(part("finding")).toBeNull()
    expect(slip().querySelectorAll("[data-score]")).toHaveLength(0)
    // Nothing is known for the meta line, so there is none.
    expect(part("meta")).toBeNull()
    expect(part("passage")!.textContent).toBe(row.text)
    expect(slip().textContent).not.toMatch(/1st/)
    // It selects nothing, so it is not a tab stop.
    expect(slip().hasAttribute("tabindex")).toBe(false)
    // The text is not a chunk, so the swatch claims nothing about one.
    const sw = slip().querySelector<HTMLElement>("[data-id]")!
    expect(sw.getAttribute("role")).toBeNull()
    expect(sw.getAttribute("aria-label")).toBeNull()
    expect(sw.getAttribute("aria-hidden")).toBe("true")
    expect(screen.queryByRole("img")).toBeNull()
    cleanup()
    // Page and section stay when they are known.
    render(<EvidenceSlip row={{ ...rows[0], section: "Methods" }} side="single" piece={null} scaleKey="score" bare />)
    expect(part("meta")!.textContent).toBe("p. 3Methods")
  })
})
