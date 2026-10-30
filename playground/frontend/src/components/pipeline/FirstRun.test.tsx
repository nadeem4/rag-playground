import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { documentOf, resetDocumentForTests } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests } from "@/state/graph"

import { FirstRun } from "./FirstRun"

const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 4096, content_type: "application/pdf" }

const SAMPLES = [
  {
    name: "chunking-primer",
    title: "A primer on chunking",
    blurb: "Three pages of notes on chunking.",
    shows: "Headings, a footer and a repeated paragraph.",
    stresses: "chunk",
    pages: 3,
    default: true,
    filename: "chunking-primer.pdf",
    sha: "cd".repeat(32),
    question: "What are the two steps?",
  },
  {
    name: "scanned-notes",
    title: "Scanned notes",
    blurb: "Two pages that are pictures of text.",
    shows: "Without OCR the parse returns nothing.",
    stresses: "parse",
    pages: 2,
    default: false,
    filename: "scanned-notes.pdf",
    sha: "ef".repeat(32),
    question: "What does a scanner actually do to a page?",
  },
]

let demo = false
let appCalls = 0
let posted: (string | null)[] = []
let uploadRefusal = ""
let linkPosts: string[] = []
let linkStatus = 200
let holdLink: Promise<void> | null = null
const registry = liveRegistry as unknown as Registry

beforeEach(() => {
  resetAppSettingsForTests()
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  demo = false
  appCalls = 0
  posted = []
  linkPosts = []
  linkStatus = 200
  holdLink = null
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") {
        appCalls += 1
        return ok(
          demo
            ? { demo, limits: { max_bytes: 10485760, max_pages: 20, max_files: 3, ttl_hours: 24, max_other_bytes: 2097152, max_image_bytes: 5242880 } }
            : { demo },
        )
      }
      if (url === "/api/v2/strategies") return ok({ stages: liveRegistry })
      if (url === "/api/v2/documents/url") {
        linkPosts.push(JSON.parse(String(init?.body)).url)
        if (holdLink) await holdLink
        if (linkStatus !== 200) return new Response(JSON.stringify({ detail: "That address is not on the public internet, so it was not fetched." }), { status: linkStatus })
        return ok(SAMPLE)
      }
      if (url === "/api/v2/documents" && init?.method === "POST") return new Response(JSON.stringify({ detail: uploadRefusal }), { status: 413 })
      if (url === "/api/v2/documents") return ok([SAMPLE])
      if (url === "/api/samples") return ok(SAMPLES)
      if (url === "/api/sources/sample") {
        posted.push(init?.body ? JSON.parse(String(init.body)).name : null)
        return ok(SAMPLE)
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const uploadButton = () => screen.queryByRole("button", { name: "Upload a file" })
const NOTE =
  "This is a hosted demo. A file you upload is private to this browser, is not shared with anyone, and is deleted after a day. A PDF up to 10 MB and 20 pages, a Word, PowerPoint, HTML, Markdown or text file up to 2 MB, and an image up to 5 MB, three at a time. Clearing cookies loses access to your uploads. For anything larger, run it locally."
const IN_A_FRAME = " Uploads need cookies. If your browser blocks them here, open the demo in its own tab."

describe("FirstRun", () => {
  it("lists every sample, the default first, with its title, blurb and the stage it stresses", async () => {
    render(<FirstRun />)
    const rows = await screen.findAllByRole("listitem")
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["A primer on chunking", "Scanned notes"])
    expect(within(rows[1]).getByText("Two pages that are pictures of text.")).toBeTruthy()
    expect(within(rows[1]).getByText("parse")).toBeTruthy()
  })

  it("outside demo mode, says files stay on this machine exactly once", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    expect(await screen.findAllByText("Your files stay on this machine and never leave it.")).toHaveLength(1)
  })

  it("Load posts the sample's name and stores the sample pipeline, with the sample's own question (F6)", async () => {
    render(<FirstRun />)
    const rows = await screen.findAllByRole("listitem")
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Load" }))
    await waitFor(() => expect(documentOf(readStoredGraph(registry))).toEqual({ sha: SAMPLE.sha, filename: SAMPLE.filename }))
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "query")!.config.text).toBe("What does a scanner actually do to a page?")
    expect(posted).toEqual(["scanned-notes"])
  })

  it("offers your earlier uploads through Pick a file or link, and has no file picker of its own", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    expect(screen.getByText("A PDF, Word, PowerPoint, Markdown, text or image file, or a link to a web page. Your earlier ones are in the list.")).toBeTruthy()
    expect(screen.getByTestId("document-trigger").textContent).toBe("Pick a file or link")
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(uploadButton()).not.toBeNull()
  })

  it("takes a link on the card: submitting a URL adds it and clears the box; an empty box posts nothing", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    const box = screen.getByLabelText("Or paste a link to a web page or PDF") as HTMLInputElement
    const add = screen.getByRole("button", { name: "Add link" }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(box, { target: { value: "   " } })
    fireEvent.submit(box.closest("form")!)
    expect(linkPosts).toEqual([])
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.change(box, { target: { value: "https://example.com/guide.html" } })
    fireEvent.click(add)
    await waitFor(() => expect(linkPosts).toEqual(["https://example.com/guide.html"]))
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE.sha))
    await waitFor(() => expect(box.value).toBe(""))
  })

  it("while a link is fetched, the box waits, Add shows the fetch, Upload keeps its words, and a second submit posts nothing", async () => {
    let release = () => {}
    holdLink = new Promise<void>((r) => (release = r))
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    const box = screen.getByLabelText("Or paste a link to a web page or PDF") as HTMLInputElement
    fireEvent.change(box, { target: { value: "https://example.com/guide.html" } })
    const form = box.closest("form")!
    fireEvent.submit(form)
    await waitFor(() => expect(box.readOnly).toBe(true))
    fireEvent.submit(form)
    expect(box.getAttribute("aria-disabled")).toBe("true")
    const add = screen.getByRole("button", { name: "Add link" }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.textContent).toContain("Fetching example.com")
    expect((uploadButton() as HTMLButtonElement).textContent).toBe("Upload a file")
    expect((uploadButton() as HTMLButtonElement).disabled).toBe(true)
    expect(linkPosts).toHaveLength(1)
    release()
    await waitFor(() => expect(box.readOnly).toBe(false))
  })

  it("shows the server's sentence when a link is refused", async () => {
    linkStatus = 400
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    fireEvent.change(screen.getByLabelText("Or paste a link to a web page or PDF"), { target: { value: "https://localhost/admin" } })
    fireEvent.click(screen.getByRole("button", { name: "Add link" }))
    expect((await screen.findByRole("alert")).textContent).toBe("That address is not on the public internet, so it was not fetched.")
  })

  it("shows a refusal under the link box when the text is not a link", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    fireEvent.change(screen.getByLabelText("Or paste a link to a web page or PDF"), { target: { value: "not a link" } })
    fireEvent.click(screen.getByRole("button", { name: "Add link" }))
    expect((await screen.findByRole("alert")).textContent).toBe("That is not a link. Paste one that starts with https://")
    expect(linkPosts).toEqual([])
  })

  it("Upload a file refuses a file no parser reads, and takes every one a parser does", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    const input = screen.getByLabelText("Upload a file to start")
    await waitFor(() => expect(input.getAttribute("accept")).toBe(".pdf,.docx,.pptx,.html,.htm,.md,.txt,.png,.jpg,.jpeg"))
    fireEvent.change(input, { target: { files: [new File(["x"], "sheet.xlsx")] } })
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Upload of sheet.xlsx failed: This kind of file cannot be read here. Upload PDF, Word, PowerPoint, HTML, Markdown, text or images.",
    )
  })

  it("shows the server's own sentence when an upload is refused, without the status and path", async () => {
    uploadRefusal = "This file is 14.2 MB. The hosted demo takes files up to 10 MB. Or split out the pages you need and upload those."
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    fireEvent.change(screen.getByLabelText("Upload a file to start"), { target: { files: [new File(["%PDF"], "big.pdf", { type: "application/pdf" })] } })
    expect((await screen.findByRole("alert")).textContent).toBe(`Upload of big.pdf failed: ${uploadRefusal}`)
  })

  it("says so, and still shows Upload, when the sample list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/v2/documents" ? [] : { detail: "down" }), { status: url === "/api/v2/documents" ? 200 : 500 })))
    render(<FirstRun />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not list the samples/)
    await waitFor(() => expect(uploadButton()).not.toBeNull())
  })

  it("in demo mode: Upload stays, the samples stay, and the note states the limits, said once", async () => {
    demo = true
    render(<FirstRun />)
    const note = await screen.findByTestId("demo-note")
    expect(note.textContent).toBe(NOTE)
    expect(screen.getByRole("link", { name: "run it locally" })).toBeTruthy()
    await waitFor(() => expect(uploadButton()).not.toBeNull())
    expect(await screen.findAllByRole("listitem")).toHaveLength(2)
  })

  it("in demo mode, the limits are not repeated under its Upload button", async () => {
    demo = true
    render(<FirstRun />)
    await screen.findByTestId("demo-note")
    await waitFor(() => expect(uploadButton()).not.toBeNull())
    expect(screen.queryByTestId("upload-limits")).toBeNull()
  })

  it("in demo mode without limits, the note still says a day, 10 MB and 20 pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
        if (url === "/api/settings/app") return ok({ demo: true })
        if (url === "/api/v2/documents") return ok([SAMPLE])
        if (url === "/api/samples") return ok(SAMPLES)
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }),
    )
    render(<FirstRun />)
    const note = await screen.findByTestId("demo-note")
    expect(note.textContent).toBe(NOTE)
  })

  it("inside an iframe, the note says uploads need cookies and links to the demo in its own tab", async () => {
    demo = true
    const real = Object.getOwnPropertyDescriptor(window, "top")
    Object.defineProperty(window, "top", { configurable: true, get: () => ({}) })
    try {
      render(<FirstRun />)
      const note = await screen.findByTestId("demo-note")
      expect(note.textContent).toBe(NOTE + IN_A_FRAME)
      const link = screen.getByRole("link", { name: "open the demo in its own tab" })
      expect(link.getAttribute("href")).toBe(window.location.href)
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.getAttribute("rel")).toBe("noreferrer")
    } finally {
      if (real) Object.defineProperty(window, "top", real)
    }
  })
})
