import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { documentOf, resetDocumentForTests } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph } from "@/state/graph"

import { DocumentControl } from "./DocumentControl"
import { FirstRun } from "./pipeline/FirstRun"
import { DocumentNote } from "./DocumentNote"

const registry = liveRegistry as unknown as Registry
const SAMPLE_SHA = "cd".repeat(32)
const UP = { sha: "12".repeat(32), filename: "my-notes.pdf", size: 7451, content_type: "application/pdf" }
const SAMPLE = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "Short paragraphs about chunking.",
  shows: "s",
  stresses: "chunk",
  pages: 2,
  default: true,
  filename: "chunking-primer.pdf",
  sha: SAMPLE_SHA,
  question: "Why do chunk boundaries matter?",
}
const LIMITS = { max_bytes: 10485760, max_pages: 20, max_files: 3, max_total_bytes: 52428800, ttl_hours: 24 }
const never = new Promise<never>(() => {})

let requests: { url: string; method: string; body?: unknown }[] = []
let holdUpload = false
let releaseUpload: () => void = () => {}

function serve({ sources, samples, app = { demo: false } }: { sources: unknown; samples: unknown; app?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      requests.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") return ok(app)
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/sources/sample" && method === "POST") return ok({ ...UP, sha: SAMPLE_SHA, filename: "chunking-primer.pdf" })
      if (url === "/api/sources" && method === "POST") {
        const answer = () => ok({ ...UP, sha: "34".repeat(32), filename: "fresh.pdf" })
        return holdUpload ? new Promise<Response>((resolve) => (releaseUpload = () => resolve(answer()))) : answer()
      }
      if (url === "/api/sources") return sources === never ? never : ok(sources)
      if (url === "/api/samples") return samples === never ? never : ok(samples)
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

const stored = (sha: string, filename: string) => storeGraph(sampleGraph(registry, { sha, filename }))
const trigger = () => screen.getByTestId("document-trigger")
const posts = () => requests.filter((r) => r.method === "POST")

beforeEach(() => {
  requests = []
  holdUpload = false
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DocumentControl", () => {
  it("names the current document, and opens a menu of samples, your uploads and Upload a PDF", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Document: chunking-primer.pdf. Change it."))
    // A narrow bar cuts the name; hovering shows it whole.
    expect(trigger().getAttribute("title")).toBe("chunking-primer.pdf")
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    const items = within(menu).getAllByRole("menuitemradio")
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"])
    expect(within(menu).getByText("Your uploads")).toBeTruthy()
    expect(within(menu).getByRole("menuitem", { name: "Upload a PDF" })).toBeTruthy()
    expect(menu.textContent).toContain("Every page uses this document. Your files stay on this machine.")
  })

  it("turns amber and reads Missing when the saved upload is gone, and the menu opens on a warning", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().className).toContain("bg-stale-wash"))
    expect(trigger().className).toContain("text-stale")
    expect(within(trigger()).getByText("Missing")).toBeTruthy()
    expect(trigger().getAttribute("aria-label")).toBe("Document NK_Resume.pdf is missing. Pick another or upload it again.")
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("NK_Resume.pdf is no longer on the server. Upload it again, or pick a sample.")
    expect(menu.textContent).not.toContain("Uploads on the demo expire.")
    expect(within(menu).getByText("None in this browser yet.")).toBeTruthy()
  })

  it("on the demo, the warning says uploads expire", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE], app: { demo: true } })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().className).toContain("bg-stale-wash"))
    await waitFor(() => expect(requests.some((r) => r.url === "/api/settings/app")).toBe(true))
    await act(async () => {})
    fireEvent.keyDown(trigger(), { key: "Enter" })
    expect((await screen.findByRole("menu")).textContent).toContain(
      "NK_Resume.pdf is no longer on the server. Uploads on the demo expire. Upload it again, or pick a sample.",
    )
  })

  it("while an upload runs, the samples, your uploads and Upload a PDF wait, so a pick cannot race it", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    holdUpload = true
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2))
    fireEvent.change(screen.getByLabelText("Upload a PDF file"), { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Uploading fresh.pdf"))
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item.getAttribute("aria-disabled")).toBe("true")
    expect(within(menu).getByRole("menuitem", { name: /Uploading fresh\.pdf/ }).getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /my-notes\.pdf/ }))
    expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA)
    await act(async () => releaseUpload())
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe("34".repeat(32)))
  })

  it("shows an upload started on the first-visit card in the bar too", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    holdUpload = true
    render(
      <>
        <DocumentControl />
        <FirstRun />
      </>,
    )
    const inputs = screen.getAllByLabelText("Upload a PDF file")
    fireEvent.change(inputs[inputs.length - 1], { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Uploading fresh.pdf"))
    expect(trigger().getAttribute("aria-busy")).toBe("true")
    await act(async () => releaseUpload())
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Document: fresh.pdf. Change it."))
  })

  it("never shows Missing while the lists are still loading", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: never, samples: never })
    render(<DocumentControl />)
    await act(async () => {})
    expect(trigger().className).not.toContain("bg-stale-wash")
    expect(trigger().getAttribute("aria-label")).toBe("Document: NK_Resume.pdf. Change it.")
  })

  it("reads Pick a document when there is none", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Pick a document"))
    expect(within(trigger()).getByText("Pick a document").className).toContain("text-fg-muted")
  })

  it("gives the trigger the full width below md and caps it at 360 px from md", () => {
    serve({ sources: [], samples: [] })
    render(<DocumentControl />)
    const c = trigger().className.split(/\s+/)
    for (const k of ["h-row", "w-full", "md:w-auto", "md:max-w-[240px]", "xl:max-w-[360px]", "rounded-control", "border-hairline"]) expect(c).toContain(k)
  })

  it("picks an upload without a request, and a sample through the sample endpoint", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    let menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2))
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /my-notes\.pdf/ }))
    await waitFor(() => expect(documentOf(readStoredGraph(registry))).toEqual({ sha: UP.sha, filename: UP.filename }))
    expect(posts()).toEqual([])
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

    fireEvent.keyDown(trigger(), { key: "Enter" })
    menu = await screen.findByRole("menu")
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /A primer on chunking/ }))
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA))
    expect(posts()).toEqual([{ url: "/api/sources/sample", method: "POST", body: { name: "chunking-primer" } }])
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "query")!.config.text).toBe(SAMPLE.question)
  })

  it("refuses a file that is not a PDF in the menu's own words", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    await screen.findByRole("menu")
    fireEvent.change(screen.getByLabelText("Upload a PDF file"), { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } })
    expect((await screen.findByRole("alert")).textContent).toBe("Upload of notes.txt failed: Only PDF files can be uploaded.")
    expect(posts()).toEqual([])
  })

  it("uploads a PDF and makes it the document", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.change(screen.getByLabelText("Upload a PDF file"), { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Document: fresh.pdf. Change it."))
    expect(documentOf(readStoredGraph(registry))?.sha).toBe("34".repeat(32))
  })

  it("states the demo's limits under the foot", async () => {
    serve({ sources: [], samples: [SAMPLE], app: { demo: true, limits: LIMITS } })
    render(<DocumentControl />)
    await waitFor(() => expect(requests.some((r) => r.url === "/api/settings/app")).toBe(true))
    await act(async () => {})
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getByTestId("upload-limits").textContent).toBe("PDF only, up to 10 MB and 20 pages."))
    expect(menu.textContent).toContain("Every page uses this document. Uploads on the demo are private to this browser and expire.")
  })

  it("says PDF only when running locally", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByTestId("upload-limits").textContent).toBe("PDF only.")
  })

  it("says when the uploads could not be listed, and offers Retry", async () => {
    serve({ sources: { detail: "x" }, samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getByText("Could not list your uploads.")).toBeTruthy())
    expect(within(menu).getByRole("menuitem", { name: "Retry" })).toBeTruthy()
  })

  it("opens from a page's Pick a document button", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(
      <>
        <DocumentControl />
        <DocumentNote action="run these recipes" />
      </>,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Pick a document" }))
    expect(await screen.findByRole("menu")).toBeTruthy()
  })
})
