import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chatJson from "@/api/fixtures/output.chat.json"
import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import cleanedJson from "@/api/fixtures/parsed_doc_cleaned.json"
import type { ChatOutput, ChunkSet, ParsedDoc } from "@/api/types"
import { clearPdfCaches } from "@/api/usePdf"
import { ChatInspector } from "@/components/inspectors/ChatInspector"
import { ChunkSetInspector } from "@/components/inspectors/ChunkSetInspector"
import { resetDocumentForTests } from "@/state/document"

import { PdfPageView } from "./PdfPageView"

const chat = chatJson as unknown as ChatOutput
const SHA = chat.payload.citations[0].source_sha
// The same pieces, from a Word file: no page anywhere.
const pdfChunks = recursiveJson as unknown as ChunkSet
const chunks: ChunkSet = { ...pdfChunks, chunks: pdfChunks.chunks.map((c) => ({ ...c, page_span: null })) }
const payload = { ...chat.payload, citations: chat.payload.citations.map((c) => ({ ...c, page: null, bbox: null })) }
const pdfDoc = cleanedJson as unknown as ParsedDoc
const wordDoc: ParsedDoc = {
  ...pdfDoc,
  filename: "field-guide.docx",
  elements: pdfDoc.elements.map((e) => ({ ...e, page: null, bbox: null })),
}

let urls: string[] = []

beforeEach(() => {
  urls = []
  clearPdfCaches()
  resetDocumentForTests()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url)
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/v2/documents") return ok([{ sha: SHA, filename: "field-guide.docx", size: 2048, content_type: "application/octet-stream" }])
      if (url === "/api/samples") return ok([])
      if (url.includes("/pages")) return ok({ detail: "The page routes read PDFs only." }, 415)
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const textView = () => document.querySelector<HTMLElement>("[data-text-view]")

describe("a document without pages", () => {
  it("Ask: a citation opens the text view with the cited piece marked, not a page or an error", async () => {
    render(<ChatInspector payload={payload} chunkSet={chunks} />)
    const row = document.querySelector<HTMLElement>("li[data-citation='1']")!
    fireEvent.click(await within(row).findByRole("button", { name: "Show in text" }))
    await waitFor(() => expect(textView()).toBeTruthy())
    expect(within(textView()!).getByText("Citation 1")).toBeTruthy()
    const marks = [...textView()!.querySelectorAll("mark")]
    expect(marks.map((m) => m.textContent)).toEqual([payload.citations[0].cited_text])
    expect(document.querySelector("[data-pdf-view]")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(urls.some((u) => u.includes("/pages"))).toBe(false)
  })

  it("Ask: an unverified citation marks its whole piece", async () => {
    render(<ChatInspector payload={payload} chunkSet={chunks} />)
    const row = document.querySelector<HTMLElement>("li[data-citation='3']")!
    fireEvent.click(await within(row).findByRole("button", { name: "Show in text" }))
    await waitFor(() => expect(textView()).toBeTruthy())
    const piece = chunks.chunks.find((c) => c.id === payload.citations[2].chunk_id)!
    expect([...textView()!.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([chunks.source_text.slice(piece.start_char, piece.end_char)])
  })

  it("a chunk's Show in text marks its source elements in the parsed text", async () => {
    render(<ChunkSetInspector chunkSet={chunks} doc={wordDoc} initialSelected={0} />)
    fireEvent.click(screen.getByRole("button", { name: "Show in text", hidden: true }))
    await waitFor(() => expect(textView()).toBeTruthy())
    const ids = chunks.chunks[0].source_element_ids
    const texts = wordDoc.elements.filter((e) => ids.includes(e.id)).map((e) => e.text)
    expect([...textView()!.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(texts)
    expect(urls.some((u) => u.includes("/pages"))).toBe(false)
  })

  it("the page view says plainly when the server has no pages for a document", async () => {
    render(<PdfPageView sha={SHA} initialPage={1} highlights={[]} title="Chunk 1" />)
    expect((await screen.findByTestId("no-pages")).textContent).toBe("This document has no pages to draw.")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
