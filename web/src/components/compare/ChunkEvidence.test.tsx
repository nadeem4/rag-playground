import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { Chunk, ChunkSet } from "@/api/types"

import { ChunkEvidence } from "./ChunkEvidence"

afterEach(cleanup)

const TOKENS = [58, 39, 50, 80, 84, 40]
const SOURCE = "x".repeat(2000)

/** A piece of `tokens` tokens, laid end to end after the ones before it at 4 characters a token. */
function chunk(i: number, tokens: number): Chunk {
  const start_char = TOKENS.slice(0, i).reduce((a, b) => a + b * 4, 0)
  const end_char = start_char + tokens * 4
  return {
    id: `k${i}`,
    text: SOURCE.slice(start_char, end_char),
    embed_text: null,
    start_char,
    end_char,
    token_count: tokens,
    kind: "text" as Chunk["kind"],
    parent_id: null,
    level: 0,
    ordinal: i,
    doc_id: "d",
    heading_path: [],
    source_element_ids: [],
    page_span: [1, 1],
    metadata: {},
  }
}

const set: ChunkSet = { doc_id: "d", source_text: SOURCE, chunker_meta: {}, chunks: TOKENS.map((t, i) => chunk(i, t)) }

const withHeading: ChunkSet = {
  ...set,
  chunks: set.chunks.map((c, i) =>
    i === 0 ? { ...c, heading_path: ["Reading order in two-column reports"], text: "## Reading order in two-column reports\n\nThe survey ran for six weeks." } : c,
  ),
}

describe("ChunkEvidence", () => {
  it("shows the numbers in sentence case, the bar to scale and four slips, then the rest on request", () => {
    render(<ChunkEvidence set={set} />)
    const dl = screen.getByTestId("chunk-numbers")
    expect([...dl.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["pieces", "tokens", "median tokens", "largest 5%", "characters left out"])
    expect(dl.querySelector("dd")!.textContent).toBe("6")
    expect(screen.getByText("The document as 6 pieces, drawn to scale by tokens.")).toBeTruthy()
    expect(screen.getAllByTestId("passage")).toHaveLength(4)
    expect(screen.getByText(/2 more pieces\./)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getAllByTestId("passage")).toHaveLength(6)
  })

  it("names each piece by number, tokens and heading, and never shows a markdown heading mark", () => {
    render(<ChunkEvidence set={withHeading} />)
    const findings = screen.getAllByTestId("finding")
    expect(findings[0].textContent).toBe("Piece 1, 58 tokens, under the heading Reading order in two-column reports")
    expect(findings[1].textContent).toBe("Piece 2, 39 tokens")
    expect(screen.getAllByTestId("passage")[0].textContent).not.toMatch(/^#/)
  })

  it("numbers and colours each slip by its piece, with no scores", () => {
    render(<ChunkEvidence set={set} />)
    expect(screen.getAllByRole("img").map((s) => s.textContent)).toEqual(["1", "2", "3", "4"])
    expect(document.querySelector("[data-score]")).toBeNull()
  })

  it("draws the bar 12 px tall, each piece as wide as its tokens", () => {
    render(<ChunkEvidence set={set} />)
    const bar = screen.getByTestId("chunk-bar")
    expect(bar.className).toContain("h-[12px]")
    expect(bar.className).toContain("gap-[2px]")
    const parts = [...bar.children] as HTMLElement[]
    expect(parts.map((p) => p.style.flexGrow)).toEqual(TOKENS.map(String))
    expect(parts[0].className).toContain("rounded-[3px]")
  })

  it("says so when there is a single piece, and offers no Show all", () => {
    render(<ChunkEvidence set={{ ...set, chunks: [chunk(0, 58)] }} />)
    expect(screen.getByText("The document as 1 piece, drawn to scale by tokens.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
  })

  it("never puts the column in a scrolling box of its own", () => {
    const { container } = render(<ChunkEvidence set={set} />)
    expect(container.innerHTML).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-/)
  })
})
