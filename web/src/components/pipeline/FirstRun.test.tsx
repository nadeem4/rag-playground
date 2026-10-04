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
const registry = liveRegistry as unknown as Registry

beforeEach(() => {
  resetAppSettingsForTests()
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  demo = false
  appCalls = 0
  posted = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") {
        appCalls += 1
        return ok(demo ? { demo, limits: { max_bytes: 10485760, max_pages: 20, max_files: 3, ttl_hours: 24 } } : { demo })
      }
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/sources" && init?.method === "POST") return new Response(JSON.stringify({ detail: uploadRefusal }), { status: 413 })
      if (url === "/api/sources") return ok([SAMPLE])
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

const uploadButton = () => screen.queryByRole("button", { name: "Upload a PDF" })
const NOTE =
  "This is a hosted demo. A PDF you upload is private to this browser, is not shared with anyone, and is deleted after a day. Files up to 10 MB and 20 pages, three at a time. Clearing cookies loses access to your uploads. For anything larger, run it locally."
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

  it("points to the bar for your uploads, and has no file picker of its own", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    expect(screen.getByText("Or pick one in the bar above.")).toBeTruthy()
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(uploadButton()).not.toBeNull()
  })

  it("Upload a PDF refuses a file that is not a PDF", async () => {
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    fireEvent.change(screen.getByLabelText("Upload a PDF file"), { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } })
    expect((await screen.findByRole("alert")).textContent).toBe("Upload of notes.txt failed: Only PDF files can be uploaded.")
  })

  it("shows the server's own sentence when an upload is refused, without the status and path", async () => {
    uploadRefusal = "This file is 14.2 MB. The hosted demo takes files up to 10 MB. Or split out the pages you need and upload those."
    render(<FirstRun />)
    await screen.findAllByRole("listitem")
    fireEvent.change(screen.getByLabelText("Upload a PDF file"), { target: { files: [new File(["%PDF"], "big.pdf", { type: "application/pdf" })] } })
    expect((await screen.findByRole("alert")).textContent).toBe(`Upload of big.pdf failed: ${uploadRefusal}`)
  })

  it("says so, and still shows Upload, when the sample list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/sources" ? [] : { detail: "down" }), { status: url === "/api/sources" ? 200 : 500 })))
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
        if (url === "/api/sources") return ok([SAMPLE])
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
