import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"

import { DocumentPanel } from "./DocumentPanel"

const SHA = "ab".repeat(32)
const SENTENCE = "A retriever scores each chunk as a whole."
// The parsed text wraps the sentence across a line, as a real parse does.
const TEXT = `## Chunking in Retrieval-Augmented Generation\n\nA retriever scores each chunk\nas a whole. The model then gets a passage.`
const DOC = { filename: "chunking-primer.pdf", page_count: 3, text: TEXT }
const PAGES = [1, 2, 3].map((n) => ({ n, width: 612, height: 792 }))

let finds: string[] = []

beforeEach(() => {
  finds = []
  window.localStorage.clear()
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/learn/document") return ok(DOC)
      if (url === `/api/sources/${SHA}/pages`) return ok(PAGES)
      if (url.startsWith(`/api/sources/${SHA}/pages/1/find`)) {
        finds.push(new URL(url, "http://x").searchParams.get("text")!)
        return ok({ rects: [[72, 600, 540, 612]], matched: "exact" })
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const panel = () => screen.getByRole("region", { name: "The document" })

describe("The document panel", () => {
  it("names the sample and how long it is, from the server", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(within(panel()).getByText(/chunking-primer\.pdf, 3 pages/)).toBeTruthy())
  })

  it("stays open beside the step and shows the real pages first", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(document.querySelector("img")).toBeTruthy())
    expect(document.querySelector("img")?.getAttribute("src")).toBe(`/api/sources/${SHA}/pages/1.png?scale=2`)
  })

  it("switches to the parsed text the steps work on, and says why the two differ", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(document.querySelector("[data-pdf-view]")).toBeTruthy())
    fireEvent.click(within(panel()).getByRole("tab", { name: "Text" }))
    expect(within(panel()).getByText(/The model then gets a passage\./)).toBeTruthy()
    expect(document.querySelector("[data-pdf-view]")).toBeNull()
    expect(within(panel()).getByText(/The steps work on the parsed text, not on the picture of the page\./)).toBeTruthy()
  })

  it("marks the sentence the step is about, on the page and in the text", async () => {
    render(<DocumentPanel sha={SHA} highlight={SENTENCE} />)
    await waitFor(() => expect(panel().querySelectorAll("[data-highlight]").length).toBe(1))
    expect(finds).toEqual([SENTENCE])
    fireEvent.click(within(panel()).getByRole("tab", { name: "Text" }))
    // The line break inside the sentence does not stop it being found.
    expect(panel().querySelector("mark")?.textContent).toBe("A retriever scores each chunk\nas a whole.")
  })

  it("marks nothing when the step is about no one sentence", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(within(panel()).getByText(/chunking-primer\.pdf, 3 pages/)).toBeTruthy())
    expect(finds).toEqual([])
    fireEvent.click(within(panel()).getByRole("tab", { name: "Text" }))
    expect(panel().querySelector("mark")).toBeNull()
  })

  it("says so when the document cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "no sample" }), { status: 500 })))
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/i))
  })
})
