import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import cleanedJson from "@/api/fixtures/parsed_doc_cleaned.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchJson from "@/api/fixtures/output.search.json"
import type { ChunkSet, ParsedDoc, RetrievalResult } from "@/api/types"
import { clearPdfCaches } from "@/api/usePdf"
import { ChunkSetInspector } from "@/components/inspectors/ChunkSetInspector"
import type { SearchOutput } from "@/components/inspectors/hits"
import { RetrievalResultInspector, SearchOutputInspector } from "@/components/inspectors/RetrievalResultInspector"

import { PdfPageView } from "./PdfPageView"

const chunks = recursiveJson as unknown as ChunkSet
const doc = cleanedJson as unknown as ParsedDoc
const hybrid = hybridJson as unknown as RetrievalResult
const search = searchJson as unknown as SearchOutput
const SHA = doc.source_id
const PAGES = [1, 2, 3].map((n) => ({ n, width: 612, height: 792 }))

let urls: string[] = []

beforeEach(() => {
  urls = []
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url)
      if (url === `/api/sources/${SHA}/pages`) return new Response(JSON.stringify(PAGES))
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const view = () => document.querySelector("[data-pdf-view]") as HTMLElement
const rects = () => [...document.querySelectorAll<HTMLElement>("[data-highlight]")]
const bboxOf = (id: string) => doc.elements.find((e) => e.id === id)!.bbox!

async function pageShown(n: number) {
  await waitFor(() => expect(view().querySelector(`[data-pdf-page="${n}"]`)).toBeTruthy())
}

describe("Show in PDF on a chunk", () => {
  it("highlights the bboxes of exactly that chunk's source elements, on its page", async () => {
    render(<ChunkSetInspector chunkSet={chunks} doc={doc} initialSelected={0} />)
    // The metadata panel is hidden by a container query jsdom cannot evaluate.
    fireEvent.click(screen.getByRole("button", { name: "Show in PDF", hidden: true }))
    await pageShown(1)
    expect(within(view()).getByTestId("pdf-page-number").textContent).toBe("p. 1 of 3")
    // Chunk 1 is cut from e00001 and e00002.
    expect(rects()).toHaveLength(2)
    const scale = 1.25
    const [l, , r, t] = bboxOf("e00002")
    const second = rects()[1]
    expect(parseFloat(second.style.left)).toBeCloseTo(l * scale, 3)
    expect(parseFloat(second.style.top)).toBeCloseTo((792 - t) * scale, 3)
    expect(parseFloat(second.style.width)).toBeCloseTo((r - l) * scale, 3)
    // The image is the server's page render at scale 2.
    expect(view().querySelector("img")!.getAttribute("src")).toBe(`/api/sources/${SHA}/pages/1.png?scale=2`)
  })

  it("a chunk spanning pages shows its first page and offers the other", async () => {
    // Chunk 4 (index 3) is cut from e00010 (p. 2) and e00011, e00014 (p. 3).
    render(<ChunkSetInspector chunkSet={chunks} doc={doc} initialSelected={3} />)
    // The metadata panel is hidden by a container query jsdom cannot evaluate.
    fireEvent.click(screen.getByRole("button", { name: "Show in PDF", hidden: true }))
    await pageShown(2)
    expect(rects()).toHaveLength(2)
    fireEvent.click(within(view()).getByRole("button", { name: "p. 3" }))
    await pageShown(3)
    expect(rects()).toHaveLength(1)
  })

  it("says plainly when the parser gave no bbox, instead of drawing nothing", async () => {
    const flat = { ...doc, parser_meta: { parser: "markitdown" }, elements: doc.elements.map((e) => ({ ...e, bbox: null })) }
    render(<ChunkSetInspector chunkSet={chunks} doc={flat} initialSelected={0} />)
    // The metadata panel is hidden by a container query jsdom cannot evaluate.
    fireEvent.click(screen.getByRole("button", { name: "Show in PDF", hidden: true }))
    await pageShown(1)
    expect(rects()).toHaveLength(0)
    expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/markitdown does not record where text sits on the page/)
  })

  it("is not offered without the parsed document", () => {
    render(<ChunkSetInspector chunkSet={chunks} initialSelected={0} />)
    expect(screen.queryByRole("button", { name: "Show in PDF", hidden: true })).toBeNull()
  })
})

describe("Show in PDF on a hit", () => {
  it("each hit row opens its own chunk's elements", async () => {
    render(<RetrievalResultInspector result={hybrid} chunkSet={chunks} doc={doc} />)
    const rows = screen.getAllByRole("listitem")
    // Rank 1 is e98302ea44442e5b: e00014, e00015, e00017, all on p. 3.
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Show in PDF" }))
    await pageShown(3)
    expect(rects()).toHaveLength(3)
    expect(within(view()).getByText("Rank 1")).toBeTruthy()
    // Rank 4 is 10a57a19c6a746b9: e00003, e00004, e00005 on p. 1.
    fireEvent.click(within(rows[3]).getByRole("button", { name: "Show in PDF" }))
    await pageShown(1)
    expect(rects()).toHaveLength(3)
  })

  it("a Search row finds its chunk in the chunk set", async () => {
    render(<SearchOutputInspector output={search} chunkSet={chunks} doc={doc} />)
    const rows = screen.getAllByRole("listitem")
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Show in PDF" }))
    const first = chunks.chunks.find((c) => c.id === search.payload.results![0].chunk_id)!
    await pageShown(first.page_span![0])
    expect(rects().length).toBeGreaterThan(0)
  })

  it("works without the chunk set, from the hit's own chunk", async () => {
    render(<RetrievalResultInspector result={hybrid} doc={doc} />)
    fireEvent.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Show in PDF" }))
    await pageShown(3)
    expect(rects()).toHaveLength(3)
  })
})

describe("PdfPageView", () => {
  it("steps through pages and stops at the ends", async () => {
    render(<PdfPageView sha={SHA} initialPage={1} highlights={[]} title="Chunk 1" />)
    await pageShown(1)
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await pageShown(3)
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows loading, then a readable error", async () => {
    render(<PdfPageView sha="unknown" initialPage={1} highlights={[]} title="Chunk 1" />)
    expect(screen.getByRole("status").textContent).toMatch(/Loading the pages/)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not load the pages of this PDF/))
  })

  it("says when the page image fails to render", async () => {
    render(<PdfPageView sha={SHA} initialPage={2} highlights={[]} title="Chunk 1" />)
    await pageShown(2)
    fireEvent.error(view().querySelector("img")!)
    expect(screen.getByRole("alert").textContent).toMatch(/Could not render page 2/)
  })
})
