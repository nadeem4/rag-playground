import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"
import { resetDocumentForTests } from "@/state/document"

import { DocumentItem } from "./DocumentItem"

const SAMPLE = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "",
  shows: "",
  stresses: "chunk",
  pages: 3,
  default: true,
  filename: "chunking-primer.pdf",
  sha: "cd".repeat(32),
  question: "Why?",
}
const UP = { sha: "12".repeat(32), filename: "my-chunking-notes.pdf", size: 7451, content_type: "application/pdf" }
const LINK = {
  sha: "56".repeat(32),
  filename: "en.wikipedia.org-wiki-Retrieval-augmented_generation.html",
  size: 40960,
  content_type: "text/html",
  origin_url: "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
}
const WORD = { sha: "78".repeat(32), filename: "field-guide.docx", size: 20480, content_type: "application/octet-stream" }
const GONE = { sha: "ef".repeat(32), filename: "onboarding-handbook.pdf" }

beforeEach(() => {
  resetDocumentForTests()
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/samples") return ok([SAMPLE])
      if (url === "/api/v2/documents") return ok([UP, LINK, WORD])
      if (url === `/api/v2/documents/${UP.sha}/pages`) return ok([1, 2, 3, 4, 5, 6].map((n) => ({ n, width: 612, height: 792 })))
      if (url === `/api/v2/documents/${SAMPLE.sha}/pages`) return ok([1, 2, 3].map((n) => ({ n, width: 612, height: 792 })))
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sample = { sha: SAMPLE.sha, filename: SAMPLE.filename }
const upload = { sha: UP.sha, filename: UP.filename }

describe("DocumentItem", () => {
  it("full: a thumbnail of page 1, the title, and a facts line of file name, pages and Sample", async () => {
    render(<DocumentItem doc={sample} />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByText("A primer on chunking")).toBeTruthy())
    const thumb = item.querySelector("img")!
    expect(thumb.getAttribute("src")).toBe(`/api/v2/documents/${SAMPLE.sha}/pages/1?scale=0.25`)
    const facts = within(item).getByTestId("document-facts")
    expect(within(facts).getByText("chunking-primer.pdf").className).toContain("font-mono")
    expect(facts.textContent).toBe("chunking-primer.pdf3 pagesSample")
    expect(within(item).getByRole("button", { name: "Preview A primer on chunking" }).textContent).toBe("Preview")
  })

  it("an upload: the title comes from the file name, its pages from the server, and the tag says Your upload", async () => {
    render(<DocumentItem doc={upload} />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByTestId("document-facts").textContent).toBe("my-chunking-notes.pdf6 pagesYour upload"))
    expect(within(item).getByText("My chunking notes")).toBeTruthy()
  })

  it("a link: its host is its title, the tag says From a link, and no page is asked for", async () => {
    render(<DocumentItem doc={{ sha: LINK.sha, filename: LINK.filename }} />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByText("en.wikipedia.org")).toBeTruthy())
    expect(within(item).getByTestId("document-facts").textContent).toBe(`${LINK.filename}From a link`)
    expect(item.querySelector("img")).toBeNull()
    expect(within(item).getByText("HTML")).toBeTruthy()
    const asked = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(asked.some((u) => u.includes("/pages"))).toBe(false)
  })

  it("a Word upload keeps Your upload, shows its kind instead of a page, and its Preview says it has no pages", async () => {
    render(<DocumentItem doc={{ sha: WORD.sha, filename: WORD.filename }} />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByTestId("document-facts").textContent).toBe("field-guide.docxYour upload"))
    expect(item.querySelector("img")).toBeNull()
    fireEvent.click(within(item).getByRole("button", { name: "Preview Field guide" }))
    expect((await screen.findByTestId("no-pages")).textContent).toBe(
      "A Word file has no pages to draw. Its text shows on the Parse step once the pipeline has run.",
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("compact: the thumbnail and the title inline, with a small Preview beside them", async () => {
    render(<DocumentItem doc={sample} size="compact" />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByText("A primer on chunking")).toBeTruthy())
    expect(item.querySelector("img")).not.toBeNull()
    expect(within(item).queryByTestId("document-facts")).toBeNull()
    expect(within(item).getByRole("button", { name: "Preview A primer on chunking" })).toBeTruthy()
  })

  it("an upload the server no longer has keeps its name, says so, and cannot be previewed", async () => {
    render(<DocumentItem doc={GONE} />)
    const item = screen.getByTestId("document-item")
    await waitFor(() => expect(within(item).getByText("Removed from the server")).toBeTruthy())
    expect(within(item).getByText("Onboarding handbook")).toBeTruthy()
    expect(within(item).getByText("onboarding-handbook.pdf")).toBeTruthy()
    const preview = within(item).getByRole("button", { name: /^Preview/ }) as HTMLButtonElement
    expect(preview.disabled).toBe(true)
    expect(preview.getAttribute("title")).toBe("Upload it again to preview it")
    expect(item.querySelector("img")).toBeNull()
  })

  it("asks the server for no page of an upload it no longer has, so nothing fails on every page load (M6)", async () => {
    render(<DocumentItem doc={GONE} />)
    // Not even while the lists are still on their way: no page picture is asked for until the file is known.
    expect(screen.getByTestId("document-item").querySelector("img")).toBeNull()
    await waitFor(() => expect(within(screen.getByTestId("document-item")).getByText("Removed from the server")).toBeTruthy())
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes(GONE.sha))).toEqual([])
  })

  it("a page can mark it removed itself", async () => {
    render(<DocumentItem doc={sample} missing />)
    expect(within(screen.getByTestId("document-item")).getByText("Removed from the server")).toBeTruthy()
  })
})

describe("the Preview sheet", () => {
  it("opens with the facts, a page jump and every page, each captioned", async () => {
    render(<DocumentItem doc={upload} />)
    const open = await screen.findByRole("button", { name: "Preview My chunking notes" })
    await waitFor(() => expect(screen.getByTestId("document-facts").textContent).toContain("6 pages"))
    fireEvent.click(open)
    const sheet = screen.getByRole("dialog", { name: "My chunking notes" })
    expect(within(sheet).getByTestId("document-facts").textContent).toBe("my-chunking-notes.pdf6 pagesYour upload")
    const jump = await within(sheet).findByRole("navigation", { name: "Go to page" })
    expect(within(jump).getAllByRole("button").map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5", "6"])
    expect(within(jump).getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("true")
    const pages = within(sheet).getAllByRole("img")
    expect(pages.map((p) => p.getAttribute("alt"))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Page ${n} of My chunking notes`))
    expect(pages[2].getAttribute("src")).toBe(`/api/v2/documents/${UP.sha}/pages/3?scale=1.5`)
    expect(within(sheet).getByText("Page 3 of 6")).toBeTruthy()
  })

  it("a page button jumps to its page and marks it current", async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    render(<DocumentItem doc={upload} />)
    await waitFor(() => expect(screen.getByTestId("document-facts").textContent).toContain("6 pages"))
    fireEvent.click(screen.getByRole("button", { name: "Preview My chunking notes" }))
    const jump = await screen.findByRole("navigation", { name: "Go to page" })
    fireEvent.click(within(jump).getByRole("button", { name: "Page 4" }))
    expect(scrolled).toHaveBeenCalled()
    expect(within(jump).getByRole("button", { name: "Page 4" }).getAttribute("aria-current")).toBe("true")
    expect(within(jump).getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBeNull()
  })

  it("Escape closes it and focus goes back to the Preview button", async () => {
    render(<DocumentItem doc={sample} />)
    const open = await screen.findByRole("button", { name: "Preview A primer on chunking" })
    fireEvent.click(open)
    expect(screen.getByRole("dialog")).toBeTruthy()
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" })
    })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(open)
  })

  it("the close button closes it too", async () => {
    render(<DocumentItem doc={sample} size="compact" />)
    const open = await screen.findByRole("button", { name: "Preview A primer on chunking" })
    fireEvent.click(open)
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(open)
  })
})
