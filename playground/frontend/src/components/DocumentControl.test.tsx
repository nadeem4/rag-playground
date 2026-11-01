import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { documentOf, documentsOf, openDocumentMenu, resetDocumentForTests } from "@/state/document"
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
let linkRefusal: string | null = null
let holdLink = false
let releaseLink: () => void = () => {}
let uploadAnswer: unknown = null
const LINK = {
  sha: "56".repeat(32),
  filename: "en.wikipedia.org-wiki-Retrieval-augmented_generation.html",
  size: 40960,
  content_type: "text/html",
  origin_url: "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
}
let releaseUpload: () => void = () => {}

function serve({ sources, samples, app = { demo: false } }: { sources: unknown; samples: unknown; app?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      requests.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") return ok(app)
      if (url === "/api/v2/strategies") return ok({ stages: liveRegistry })
      if (url === "/api/sources/sample" && method === "POST") return ok({ ...UP, sha: SAMPLE_SHA, filename: "chunking-primer.pdf" })
      if (url === "/api/v2/documents/url" && method === "POST") {
        if (linkRefusal) return new Response(JSON.stringify({ detail: linkRefusal }), { status: 403 })
        return holdLink ? new Promise<Response>((resolve) => (releaseLink = () => resolve(ok(LINK)))) : ok(LINK)
      }
      if (url === "/api/v2/documents" && method === "POST") {
        if (uploadAnswer) return ok(uploadAnswer)
        const answer = () => ok({ ...UP, sha: "34".repeat(32), filename: "fresh.pdf" })
        return holdUpload ? new Promise<Response>((resolve) => (releaseUpload = () => resolve(answer()))) : answer()
      }
      if (url === "/api/v2/documents") return sources === never ? never : ok(sources)
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
  linkRefusal = null
  holdLink = false
  uploadAnswer = null
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
  it("names the current document, and opens a menu of samples, your uploads and Upload a file", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now chunking-primer.pdf."))
    expect(trigger().textContent).toBe("Change")
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    // Above the round Ask button (z-40) on a phone, which otherwise covered its foot.
    expect(menu.className.split(/\s+/)).toContain("z-50")
    const items = within(menu).getAllByRole("menuitemradio")
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"])
    expect(within(menu).getByText("Your uploads")).toBeTruthy()
    expect(within(menu).getByRole("menuitem", { name: "Upload a file" })).toBeTruthy()
    expect(menu.textContent).toContain("The pipeline runs on this document. Your files stay on this machine.")
  })

  it("names its action with the page's own words, such as Add or change on Build", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(<DocumentControl label="Add or change" />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Add or change the document. Now chunking-primer.pdf."))
    expect(trigger().textContent).toBe("Add or change")
  })

  it("says the saved upload is missing in its name, and the menu opens on a warning", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Document NK_Resume.pdf is missing. Pick another or upload it again."))
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("NK_Resume.pdf is no longer on this machine. Upload it again, or pick a sample.")
    expect(menu.textContent).not.toContain("on the server")
    expect(within(menu).getByText("None in this browser yet.")).toBeTruthy()
  })

  it("on the demo, the warning says the file is no longer on the demo, in Home's words", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE], app: { demo: true } })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toContain("is missing"))
    await waitFor(() => expect(requests.some((r) => r.url === "/api/settings/app")).toBe(true))
    await act(async () => {})
    fireEvent.keyDown(trigger(), { key: "Enter" })
    expect((await screen.findByRole("menu")).textContent).toContain(
      "NK_Resume.pdf is no longer on the demo. Upload it again, or pick a sample.",
    )
  })

  it("gives focus back to the button that opened the menu from a page, not the control's trigger", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(
      <>
        <DocumentControl />
        <button type="button" onClick={openDocumentMenu}>
          Change
        </button>
      </>,
    )
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now chunking-primer.pdf."))
    const opener = screen.getByRole("button", { name: "Change" })
    opener.focus()
    fireEvent.click(opener)
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(menu, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it("gives focus back to the trigger when the trigger opened the menu", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    render(
      <>
        <DocumentControl />
        <button type="button" onClick={openDocumentMenu}>
          Change
        </button>
      </>,
    )
    // A page opened it once before; the trigger opening it now wins.
    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    trigger().focus()
    fireEvent.keyDown(trigger(), { key: "Enter" })
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("while an upload runs, the samples, your uploads and Upload a file wait, so a pick cannot race it", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    holdUpload = true
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2))
    fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Uploading fresh.pdf"))
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item.getAttribute("aria-disabled")).toBe("true")
    expect(within(menu).getByRole("menuitem", { name: /Uploading fresh\.pdf/ }).getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /my-notes\.pdf/ }))
    expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA)
    await act(async () => releaseUpload())
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe("34".repeat(32)))
  })

  it("shows an upload started on the first-visit card in the control too", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    holdUpload = true
    // The first-visit card holds the control itself.
    render(<FirstRun />)
    const inputs = screen.getAllByLabelText("Upload a file")
    fireEvent.change(inputs[inputs.length - 1], { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Uploading fresh.pdf"))
    expect(trigger().getAttribute("aria-busy")).toBe("true")
    await act(async () => releaseUpload())
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now fresh.pdf."))
  })

  it("moves a sample saved with an old fingerprint to its current copy, never missing, and the menu says so in status tone", async () => {
    stored("ab".repeat(32), "chunking-primer.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA))
    expect(trigger().getAttribute("aria-label")).not.toContain("missing")
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    const note = within(menu).getByText("The sample chunking-primer.pdf was updated, so this page now uses its current copy.")
    expect(note.getAttribute("role")).toBe("status")
    expect(note.className).not.toContain("stale")
  })

  it("never shows Missing while the lists are still loading", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: never, samples: never })
    render(<DocumentControl />)
    await act(async () => {})
    expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now NK_Resume.pdf.")
  })

  it("reads Pick a file or link when there is none", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Pick a file or link"))
    expect(trigger().textContent).toBe("Pick a file or link")
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

  it("refuses a file no parser reads in the menu's own words", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    await screen.findByRole("menu")
    fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [new File(["x"], "sheet.xlsx")] } })
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Upload of sheet.xlsx failed: This kind of file cannot be read here. Upload PDF, Word, PowerPoint, HTML, Markdown, text or images.",
    )
    expect(posts()).toEqual([])
  })

  it("uploads a PDF and makes it the document", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now fresh.pdf."))
    expect(documentOf(readStoredGraph(registry))?.sha).toBe("34".repeat(32))
  })

  it("states the demo's limits under the foot", async () => {
    serve({ sources: [], samples: [SAMPLE], app: { demo: true, limits: LIMITS } })
    render(<DocumentControl />)
    await waitFor(() => expect(requests.some((r) => r.url === "/api/settings/app")).toBe(true))
    await act(async () => {})
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() =>
      expect(within(menu).getByTestId("upload-limits").textContent).toBe(
        "PDF, Word, PowerPoint, HTML, Markdown, text or images. A PDF up to 10 MB and 20 pages.",
      ),
    )
    expect(menu.textContent).toContain("The pipeline runs on this document. Uploads on the demo are private to this browser and expire.")
    expect(menu.textContent).toContain("A link is fetched once and kept like an upload. Only public web addresses work.")
  })

  it("names the formats when running locally", async () => {
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByTestId("upload-limits").textContent).toBe("PDF, Word, PowerPoint, HTML, Markdown, text or images.")
    expect(menu.textContent).toContain("A link is fetched once and kept like an upload.")
    expect(menu.textContent).not.toContain("Only public web addresses work.")
  })

  it("says when the uploads could not be listed, and offers Retry", async () => {
    serve({ sources: { detail: "x" }, samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getByText("Could not list your uploads.")).toBeTruthy())
    expect(within(menu).getByRole("menuitem", { name: "Retry" })).toBeTruthy()
  })

  it("opens from a page's Pick a file or link button", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    render(
      <>
        <DocumentControl />
        <DocumentNote action="run these recipes" />
      </>,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Pick a file or link" }))
    expect(await screen.findByRole("menu")).toBeTruthy()
  })

  it("with its own document and onChoose, a pick goes to the page and the pipeline on Build stays", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [UP], samples: [SAMPLE] })
    const chosen: unknown[] = []
    render(<DocumentControl value={{ sha: UP.sha, filename: UP.filename }} onChoose={(d) => void chosen.push(d)} foot="Trying another document does not change a saved pipeline." />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: /my-notes\.pdf/ }).getAttribute("aria-checked")).toBe("true"))
    expect(menu.textContent).toContain("Trying another document does not change a saved pipeline.")
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /A primer on chunking/ }))
    await waitFor(() => expect(chosen).toEqual([{ sha: SAMPLE_SHA, filename: "chunking-primer.pdf" }]))
    expect(posts()).toEqual([{ url: "/api/sources/sample", method: "POST", body: { name: "chunking-primer" } }])
    // Build's working copy is untouched.
    expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA)
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "source")!.config.filename).toBe("chunking-primer.pdf")
  })

  it("with onChoose, an uploaded PDF goes to the page, not to the pipeline on Build", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    serve({ sources: [], samples: [SAMPLE] })
    const chosen: unknown[] = []
    render(<DocumentControl value={null} onChoose={(d) => void chosen.push(d)} />)
    fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [new File(["%PDF"], "fresh.pdf", { type: "application/pdf" })] } })
    await waitFor(() => expect(chosen).toEqual([{ sha: "34".repeat(32), filename: "fresh.pdf" }]))
    expect(documentOf(readStoredGraph(registry))?.sha).toBe(SAMPLE_SHA)
  })

  it("uploads a Word file and shows it; the file input takes every format a parser reads", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    uploadAnswer = { sha: "78".repeat(32), filename: "field-guide.docx", size: 20480, content_type: "application/octet-stream" }
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    const input = screen.getByLabelText("Upload a file")
    await waitFor(() => expect(input.getAttribute("accept")).toBe(".pdf,.docx,.pptx,.html,.htm,.md,.txt,.png,.jpg,.jpeg"))
    fireEvent.change(input, { target: { files: [new File(["PK"], "field-guide.docx")] } })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Change the document. Now field-guide.docx."))
    expect(posts().map((p) => p.url)).toEqual(["/api/v2/documents"])
  })

  it("adds a link: sends it, and the new document shows its host and From a link", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    let listed: unknown[] = []
    serve({ sources: [], samples: [SAMPLE] })
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      url === "/api/v2/documents" && (init?.method ?? "GET") === "GET" ? new Response(JSON.stringify(listed)) : base(url, init),
    )
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    listed = [LINK]
    fireEvent.change(within(menu).getByLabelText("Link to a web page or PDF"), {
      target: { value: " https://en.wikipedia.org/wiki/Retrieval-augmented_generation " },
    })
    fireEvent.click(within(menu).getByRole("button", { name: "Add link" }))
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe(LINK.sha))
    expect(posts()).toEqual([
      { url: "/api/v2/documents/url", method: "POST", body: { url: "https://en.wikipedia.org/wiki/Retrieval-augmented_generation" } },
    ])
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const again = await screen.findByRole("menu")
    const item = await within(again).findByRole("menuitemradio", { name: /en\.wikipedia\.org/ })
    expect(item.textContent).toContain("From a link")
    expect(item.textContent).not.toContain(".html")
  })

  it("a refused link shows the server's own sentence, and a non-link is caught before sending", async () => {
    linkRefusal = "That address is not on the public internet, so it was not fetched."
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    const box = within(menu).getByLabelText("Link to a web page or PDF")
    fireEvent.change(box, { target: { value: "not a link" } })
    fireEvent.click(within(menu).getByRole("button", { name: "Add link" }))
    expect((await within(menu).findByRole("alert")).textContent).toBe("That is not a link. Paste one that starts with https://")
    expect(posts()).toEqual([])
    fireEvent.change(box, { target: { value: "https://localhost/admin" } })
    fireEvent.click(within(menu).getByRole("button", { name: "Add link" }))
    await waitFor(() =>
      expect(within(menu).getByRole("alert").textContent).toBe("That address is not on the public internet, so it was not fetched."),
    )
  })

  it("the link box is reached and used by keyboard alone, and keeps focus while the page is fetched", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    holdLink = true
    serve({ sources: [], samples: [SAMPLE] })
    render(<DocumentControl />)
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    const item = within(menu).getByRole("menuitem", { name: "Or paste a link to a web page or PDF" })
    fireEvent.keyDown(menu, { key: "End" })
    await waitFor(() => expect(document.activeElement).toBe(item))
    fireEvent.keyDown(item, { key: "Enter" })
    const box = within(menu).getByLabelText("Link to a web page or PDF") as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.change(box, { target: { value: LINK.origin_url } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Fetching en.wikipedia.org"))
    expect(posts()).toEqual([{ url: "/api/v2/documents/url", method: "POST", body: { url: LINK.origin_url } }])
    expect(box.disabled).toBe(false)
    expect(box.readOnly).toBe(true)
    expect(box.getAttribute("aria-disabled")).toBe("true")
    expect(document.activeElement).toBe(box)
    await act(async () => releaseLink())
    await waitFor(() => expect(documentOf(readStoredGraph(registry))?.sha).toBe(LINK.sha))
    expect(documentOf(readStoredGraph(registry))?.url).toBe(LINK.origin_url)
  })
})

describe("adding to a pipeline's documents (Build)", () => {
  const primer = { sha: SAMPLE_SHA, filename: "chunking-primer.pdf" }

  it("adds a picked upload after the pipeline's documents, and says which ones it has", async () => {
    serve({ sources: [UP], samples: [SAMPLE] })
    stored(primer.sha, primer.filename)
    render(<DocumentControl adds={[primer]} />)
    expect(trigger().textContent).toBe("Add a file or link")
    fireEvent.keyDown(trigger(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2))
    expect(within(menu).getByRole("menuitemradio", { name: /A primer on chunking/ }).textContent).toContain("In this pipeline")
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /my-notes\.pdf/ }))
    await waitFor(() => expect(documentsOf(readStoredGraph(registry))).toEqual([primer, { sha: UP.sha, filename: UP.filename }]))
  })

  it("picks as the plain control does when the pipeline has no document yet", async () => {
    serve({ sources: [UP], samples: [SAMPLE] })
    render(<DocumentControl adds={[]} />)
    expect(trigger().textContent).toBe("Pick a file or link")
  })
})
