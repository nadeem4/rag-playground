import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"

import { DocumentPanel } from "./DocumentPanel"

const SHA = "ab".repeat(32)
const TEXT = "## Chunking in Retrieval-Augmented Generation\n\nA retriever scores each chunk as a whole."
const DOC = { filename: "chunking-primer.pdf", page_count: 3, text: TEXT }
const PAGES = [1, 2, 3].map((n) => ({ n, width: 612, height: 792 }))

beforeEach(() => {
  window.localStorage.clear()
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/learn/document") return ok(DOC)
      if (url === `/api/sources/${SHA}/pages`) return ok(PAGES)
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const panel = () => screen.getByRole("region", { name: "The document" })
const toggle = () => within(panel()).getByRole("button", { name: /The document/ })

describe("The document panel", () => {
  it("names the sample and how long it is, from the server", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(within(panel()).getByText(/chunking-primer\.pdf, 3 pages/)).toBeTruthy())
  })

  it("opens for the first lesson and shows the real pages first", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("true"))
    await waitFor(() => expect(document.querySelector("img")).toBeTruthy())
    expect(document.querySelector("img")?.getAttribute("src")).toBe(`/api/sources/${SHA}/pages/1.png?scale=2`)
  })

  it("switches to the parsed text the steps work on, and says why the two differ", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(document.querySelector("[data-pdf-view]")).toBeTruthy())
    fireEvent.click(within(panel()).getByRole("tab", { name: "Text" }))
    expect(within(panel()).getByText(/A retriever scores each chunk as a whole\./)).toBeTruthy()
    expect(document.querySelector("[data-pdf-view]")).toBeNull()
    expect(within(panel()).getByText(/The steps work on the parsed text, not on the picture of the page\./)).toBeTruthy()
  })

  it("closes on a click, and starts closed in the next lesson", async () => {
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("true"))
    fireEvent.click(toggle())
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector("[data-pdf-view]")).toBeNull()
    cleanup()
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(within(panel()).getByText(/chunking-primer\.pdf/)).toBeTruthy())
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
  })

  it("says so when the document cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "no sample" }), { status: 500 })))
    render(<DocumentPanel sha={SHA} />)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/i))
  })
})
