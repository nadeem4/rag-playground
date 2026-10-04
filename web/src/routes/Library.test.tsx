import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetExperimentsForTests } from "@/state/experiments"
import { resetDocumentForTests, withDocument } from "@/state/document"
import { initialGraph, storedGraphJson } from "@/state/graph"
import { bytesToBase64 } from "@/state/library"
import { EXPERIMENTS_KEY, OPEN_EXPERIMENT_KEY } from "@/state/libraryExperiments"
import { readCurrentId, readPipelines, resetPipelinesForTests } from "@/state/pipelines"

import { Library } from "./Library"

const registry = liveRegistry as unknown as Registry
const UP = "ab".repeat(32)
const GONE = "ef".repeat(32)
const SAMPLE = "cd".repeat(32)
const H = 3_600_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const PDF = new Uint8Array([37, 80, 68, 70, 45])

const sampleCard = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "",
  shows: "",
  stresses: "chunk",
  pages: 3,
  default: true,
  filename: "chunking-primer.pdf",
  sha: SAMPLE,
  question: "Why?",
}

function seed() {
  const g = (sha: string, filename: string) => withDocument(initialGraph(registry), { sha, filename })
  window.localStorage.setItem(
    "rag-playground:pipelines:v1",
    JSON.stringify([
      { id: "p1", name: "Resume, sections whole", graph: g(UP, "NK_Resume.pdf"), savedAt: iso(2 * H) },
      { id: "p3", name: "Old notes test", graph: g(GONE, "my-notes.pdf"), savedAt: iso(4 * 24 * H) },
    ]),
  )
  window.localStorage.setItem(
    EXPERIMENTS_KEY,
    JSON.stringify([
      {
        id: "e1",
        name: "Chunk sizes on the primer",
        stage: "chunk",
        recipes: [1, 2, 3, 4, 5].map((n) => ({ transform: "recursive_character", config: { chunk_size: n * 100 } })),
        doc: { sha: SAMPLE, filename: "chunking-primer.pdf" },
        savedAt: iso(3 * H),
      },
    ]),
  )
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
let demo = true
let uploads: { sha: string; filename: string; uploaded_at?: string; size?: number }[] = []
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetPipelinesForTests()
  resetExperimentsForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
  demo = true
  uploads = [{ sha: UP, filename: "NK_Resume.pdf", uploaded_at: iso(20 * H) }]
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/app") return ok(demo ? { demo: true, limits: { max_bytes: 1, max_pages: 20, max_files: 3, max_total_bytes: 1, ttl_hours: 24 } } : { demo: false })
    if (url === "/api/samples") return ok([sampleCard])
    if (url === "/api/registry") return ok(registry)
    if (url === "/api/sources" && init?.method === "POST") {
      const file = (init.body as FormData).get("file") as File
      if (file.name === "big.pdf") return new Response(JSON.stringify({ detail: "The demo is full right now." }), { status: 503 })
      return ok({ sha: GONE, filename: file.name, size: file.size, content_type: "application/pdf" })
    }
    if (url === "/api/sources") return ok(uploads.map((u) => ({ size: 1_200_000, content_type: "application/pdf", ...u })))
    if (url === `/api/sources/${UP}/file`) return new Response(PDF, { status: 200 })
    return new Response("not found", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const list = () => screen.getByRole("list", { name: "Saved items" })
const row = (name: string) => within(list()).getByText(name).closest("li") as HTMLElement

async function ready(go = vi.fn()) {
  render(<Library go={go} />)
  await waitFor(() => expect(within(row("Resume, sections whole")).getByText(/deleted from the demo in/)).toBeTruthy())
  return go
}

describe("Library", () => {
  it("lists pipelines and experiments, newest first, with counts on the filters", async () => {
    seed()
    await ready()
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeTruthy()
    const names = within(list()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(names).toEqual(["Resume, sections whole", "Chunk sizes on the primer", "Old notes test"])
    const filters = screen.getByRole("group", { name: "Show" })
    expect(within(filters).getByRole("button", { name: /All 3/ }).getAttribute("aria-pressed")).toBe("true")
    expect(within(filters).getByRole("button", { name: /Pipelines 2/ })).toBeTruthy()
    expect(within(filters).getByRole("button", { name: /Experiments 1/ })).toBeTruthy()
    expect(within(row("Chunk sizes on the primer")).getByText("Chunk, 5 recipes")).toBeTruthy()
    expect(within(row("Chunk sizes on the primer")).getByText("Saved 3 hours ago")).toBeTruthy()
    expect(within(row("Chunk sizes on the primer")).getByText("Experiment")).toBeTruthy()
    expect(within(row("Old notes test")).getByText("Pipeline")).toBeTruthy()
  })

  it("filters to one kind", async () => {
    seed()
    await ready()
    fireEvent.click(screen.getByRole("button", { name: /Experiments 1/ }))
    expect(within(list()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Chunk sizes on the primer"])
  })

  it("says where each document stands: a sample, an upload's hours left, or gone", async () => {
    seed()
    await ready()
    expect(within(row("Chunk sizes on the primer")).getByText("chunking-primer.pdf, a sample, always there")).toBeTruthy()
    expect(within(row("Resume, sections whole")).getByText("NK_Resume.pdf is deleted from the demo in 4 hours. Export with the document to keep it.")).toBeTruthy()
    expect(within(row("Old notes test")).getByText("my-notes.pdf is no longer on the demo. Opening this asks you to upload it again.")).toBeTruthy()
  })

  it("warns in amber when a saved item's upload has under 6 hours left, and offers to export them with the document", async () => {
    seed()
    await ready()
    const warn = screen.getByTestId("upload-warning")
    expect(warn.className).toContain("bg-stale-wash")
    expect(warn.textContent).toContain("1 saved item uses an upload that is deleted from the demo in 4 hours.")
    fireEvent.click(within(warn).getByRole("button", { name: "Export them with the document" }))
    const sheet = screen.getByRole("dialog", { name: /Export/ })
    expect(within(sheet).getByRole("checkbox", { name: /Include the document/ })).toHaveProperty("checked", true)
    expect(within(sheet).getByText("rag-playground-resume-sections-whole.ragplayground.json")).toBeTruthy()
  })

  it("gives no warning when every upload has time left", async () => {
    seed()
    uploads = [{ sha: UP, filename: "NK_Resume.pdf", uploaded_at: iso(2 * H) }]
    render(<Library go={vi.fn()} />)
    await waitFor(() => expect(within(row("Resume, sections whole")).getByText("NK_Resume.pdf, on the demo for 22 more hours")).toBeTruthy())
    expect(screen.queryByTestId("upload-warning")).toBeNull()
  })

  it("says on this machine when running locally, with no warning", async () => {
    seed()
    demo = false
    render(<Library go={vi.fn()} />)
    await waitFor(() => expect(within(row("Resume, sections whole")).getByText("NK_Resume.pdf, on this machine")).toBeTruthy())
    expect(screen.queryByTestId("upload-warning")).toBeNull()
  })

  it("shows the empty state when nothing is saved", async () => {
    render(<Library go={vi.fn()} />)
    expect(await screen.findByText(/Nothing saved yet\. Save a pipeline on Build, or an experiment on Compare/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Export everything" })).toHaveProperty("disabled", true)
  })

  it("deletes a pipeline and an experiment from their stores", async () => {
    seed()
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Delete Old notes test" }))
    expect(readPipelines().map((p) => p.id)).toEqual(["p1"])
    fireEvent.click(screen.getByRole("button", { name: "Delete Chunk sizes on the primer" }))
    expect(window.localStorage.getItem(EXPERIMENTS_KEY)).toBeNull()
    expect(within(list()).getAllByRole("heading", { level: 2 })).toHaveLength(1)
  })

  it("opens a pipeline as the working pipeline on Build", async () => {
    seed()
    const go = await ready()
    fireEvent.click(within(row("Resume, sections whole")).getByRole("button", { name: "Open in Build" }))
    await waitFor(() => expect(go).toHaveBeenCalledWith("/build"))
    expect(readCurrentId()).toBe("p1")
    expect(storedGraphJson()).toContain(UP)
  })

  it("opens an experiment on Compare through sessionStorage", async () => {
    seed()
    const go = await ready()
    fireEvent.click(within(row("Chunk sizes on the primer")).getByRole("button", { name: "Open in Compare" }))
    expect(window.sessionStorage.getItem(OPEN_EXPERIMENT_KEY)).toBe("e1")
    expect(go).toHaveBeenCalledWith("/compare")
  })

  it("exports one item with its document as one file through a Blob", async () => {
    seed()
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b)
      return "blob:x"
    })
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    await ready()
    fireEvent.click(within(row("Resume, sections whole")).getByRole("button", { name: "Export" }))
    const sheet = screen.getByRole("dialog", { name: /Export/ })
    expect(within(sheet).getByRole("checkbox", { name: /Include the document/ })).toHaveProperty("checked", true)
    fireEvent.click(within(sheet).getByRole("button", { name: "Export" }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const file = JSON.parse(await blobs[0].text())
    expect(file.format).toBe("rag-playground-library")
    expect(file.version).toBe(1)
    expect(file.items.map((i: { id: string }) => i.id)).toEqual(["p1"])
    expect(file.documents).toEqual([{ sha: UP, filename: "NK_Resume.pdf", pdfBase64: bytesToBase64(PDF) }])
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe("rag-playground-resume-sections-whole.ragplayground.json")
    expect(await screen.findByText(/Exported 1 item and its document to rag-playground-resume-sections-whole\.ragplayground\.json\./)).toBeTruthy()
  })

  it("exports several picked items at once", async () => {
    seed()
    await ready()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Resume, sections whole" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Old notes test" }))
    const bar = screen.getByRole("region", { name: "Selection" })
    expect(within(bar).getByText("2 items picked")).toBeTruthy()
    fireEvent.click(within(bar).getByRole("button", { name: "Export them" }))
    const sheet = screen.getByRole("dialog", { name: /Export 2 items/ })
    expect(within(sheet).getByText(/rag-playground-library-\d{4}-\d{2}-\d{2}\.ragplayground\.json/)).toBeTruthy()
  })

  it("imports a file by the picker, merges by id, uploads its documents and says so in one line", async () => {
    seed()
    await ready()
    const file = {
      format: "rag-playground-library",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: [
        { kind: "pipeline", id: "p1", name: "Resume, sections whole", graph: initialGraph(registry), savedAt: iso(H) },
        { kind: "pipeline", id: "p9", name: "From another browser", graph: initialGraph(registry), savedAt: iso(H) },
        { kind: "experiment", id: "e9", name: "Reranker trial", stage: "rerank", recipes: [{ transform: "cross_encoder", config: {} }], doc: null, savedAt: iso(H) },
        { kind: "notes", id: "x" },
      ],
      documents: [
        { sha: GONE, filename: "my-notes.pdf", pdfBase64: bytesToBase64(PDF) },
        { sha: "12".repeat(32), filename: "big.pdf", pdfBase64: bytesToBase64(PDF) },
        { sha: "56".repeat(32), filename: "bad.pdf", pdfBase64: "%%% not base64 %%%" },
        { sha: "34".repeat(32), filename: "other.pdf", pdfBase64: bytesToBase64(PDF) },
      ],
    }
    const input = screen.getByLabelText("Import a file", { selector: "input" })
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(file)], "lib.json", { type: "application/json" })] } })
    const line = await screen.findByText(/^Imported 1 pipeline and 1 experiment from lib\.json\./)
    expect(line.textContent).toBe(
      "Imported 1 pipeline and 1 experiment from lib.json. 1 item was already here. Skipped 1 item that is not a pipeline or an experiment. " +
        "my-notes.pdf is back on the server. big.pdf was not uploaded: The demo is full right now. bad.pdf: the document in the file is damaged. " +
        "other.pdf was uploaded, but it is not the document the file names, so saved items may still ask for it.",
    )
    expect(readPipelines().map((p) => p.id).sort()).toEqual(["p1", "p3", "p9"])
    // The damaged one never reaches the server.
    expect(fetchMock.mock.calls.filter(([u, i]) => u === "/api/sources" && i?.method === "POST")).toHaveLength(3)
  })

  it("states a small document's size in KB", async () => {
    seed()
    uploads = [{ sha: UP, filename: "NK_Resume.pdf", uploaded_at: iso(20 * H), size: 5000 } as (typeof uploads)[number]]
    await ready()
    fireEvent.click(within(row("Resume, sections whole")).getByRole("button", { name: "Export" }))
    expect(screen.getByRole("dialog", { name: /Export/ }).textContent).toContain("NK_Resume.pdf, about 5 KB.")
  })

  it("says Without them when several documents can go in the file", async () => {
    seed()
    uploads = [
      { sha: UP, filename: "NK_Resume.pdf", uploaded_at: iso(20 * H) },
      { sha: GONE, filename: "my-notes.pdf", uploaded_at: iso(2 * H) },
    ]
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Export everything" }))
    const sheet = screen.getByRole("dialog", { name: /Export/ })
    expect(within(sheet).getByRole("checkbox", { name: /Include the documents/ })).toBeTruthy()
    expect(sheet.textContent).toContain("Without them, importing later")
  })

  it("imports a file dropped on the drop zone, and refuses one that is not ours", async () => {
    seed()
    await ready()
    const zone = screen.getByTestId("import-drop")
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["nope"], "x.json")] } })
    expect(await screen.findByText("This is not a RAG Playground file. Export from Library makes one.")).toBeTruthy()
  })

  it("uses only the theme's spacing steps and breakpoints in its files", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Library.tsx"]
    const offScale = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
    for (const f of files) {
      const src = readFileSync(`${__dirname}/../${f}`, "utf8")
      expect(src, f).not.toMatch(offScale)
      expect(src, f).not.toMatch(/(^|[\s"'`])(?:sm|2xl|max-sm):/m)
      expect(src, f).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it("has no em-dashes or en-dashes on the page", async () => {
    seed()
    await ready()
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/)
  })
})
