import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetDocumentForTests, withDocument } from "@/state/document"
import { resetStoredGraphForTests, sampleGraph, storeGraph } from "@/state/graph"

import { DocumentNote, needsDocument } from "./DocumentNote"

const registry = liveRegistry as unknown as Registry
const SAMPLE_SHA = "cd".repeat(32)
const SAMPLE = { name: "chunking-primer", title: "A primer", blurb: "b", shows: "s", stresses: "chunk", pages: 2, default: true, filename: "chunking-primer.pdf", sha: SAMPLE_SHA, question: "q" }

let demo = false
let refuseLink = false
let linkCalls = 0

beforeEach(() => {
  demo = false
  refuseLink = false
  linkCalls = 0
  resetAppSettingsForTests()
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") return ok({ demo })
      if (url === "/api/v2/documents") return ok([])
      if (url === "/api/v2/documents/url") {
        linkCalls += 1
        return refuseLink ? new Response(JSON.stringify({ detail: "Too many links" }), { status: 429 }) : ok({ sha: "34".repeat(32), filename: "page.html", size: 9, content_type: "text/html", origin_url: "https://example.com/page" })
      }
      if (url === "/api/samples") return ok([SAMPLE])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const stored = (sha: string, filename: string) => storeGraph(sampleGraph(registry, { sha, filename }))

describe("DocumentNote", () => {
  it("says the missing file, what it blocks, and offers Pick a file or link, as a stale-tone status", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toBe("NK_Resume.pdf is missing. Pick a document above to build the index.Pick a file or link")
    expect(note.getAttribute("role")).toBe("status")
    for (const c of ["bg-stale-wash", "text-stale"]) expect(note.className).toContain(c)
  })

  it("on the demo, says uploads expire", async () => {
    demo = true
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" />)
    await waitFor(() =>
      expect(screen.getByTestId("document-note").textContent).toBe(
        "NK_Resume.pdf is missing. Uploads on the demo expire. Pick a document above to build the index.Pick a file or link",
      ),
    )
  })

  it("on Build and Evaluate, points at where that page picks the document", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" where="under Documents" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toBe("NK_Resume.pdf is missing. Pick a document under Documents to build the index.Pick a file or link")
  })

  it("judges a page's own document when given one, not the pipeline on Build", async () => {
    stored(SAMPLE.sha, SAMPLE.filename)
    render(<DocumentNote action="run the evaluation" where="under Documents" doc={{ sha: "ef".repeat(32), filename: "gone.pdf" }} />)
    await waitFor(() => expect(screen.getByTestId("document-note").textContent).toContain("gone.pdf is missing."))
  })

  it("asks for a document when there is none", async () => {
    render(<DocumentNote action="run the evaluation" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toBe("Pick a document above to run the evaluation.Pick a file or link")
    expect(screen.getByRole("button", { name: "Pick a file or link" })).toBeTruthy()
  })

  it("says the document changed, with no button", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    render(<DocumentNote action="build the index" changed />)
    await waitFor(() =>
      expect(screen.getByTestId("document-note").textContent).toBe(
        "The document changed to chunking-primer.pdf. The results below are from the old one. Run again to update them.",
      ),
    )
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("shows nothing when the document is ready and unchanged", async () => {
    stored(SAMPLE_SHA, "chunking-primer.pdf")
    render(<DocumentNote action="build the index" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("document-note")).toBeNull()
  })

  it("says once, in status tone, when a sample saved with an old fingerprint moved to its current copy", async () => {
    stored("ab".repeat(32), "chunking-primer.pdf")
    render(<DocumentNote action="build the index" />)
    const note = await screen.findByTestId("document-note")
    await waitFor(() => expect(note.textContent).toBe("The sample chunking-primer.pdf was updated, so this page now uses its current copy."))
    expect(note.getAttribute("role")).toBe("status")
    expect(note.className).not.toContain("stale")
    expect(note.className).toContain("text-fg-muted")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("needsDocument is true for no document and a missing one only", () => {
    expect(needsDocument("empty")).toBe(true)
    expect(needsDocument("missing")).toBe(true)
    expect(needsDocument("checking")).toBe(false)
    expect(needsDocument("ready")).toBe(false)
  })

  it("fetches a link document again by itself, and drops the note once it is back", async () => {
    demo = true
    storeGraph(withDocument(sampleGraph(registry, { sha: "ef".repeat(32), filename: "page.html" }), { sha: "ef".repeat(32), filename: "page.html", url: "https://example.com/page" }))
    render(<DocumentNote action="build the index" />)
    await waitFor(() => expect(linkCalls).toBe(1))
    await waitFor(() => expect(screen.queryByTestId("document-note")).toBeNull())
  })

  it("when the link is refused, shows the server's sentence and offers Fetch again beside Pick a file or link", async () => {
    demo = true
    refuseLink = true
    storeGraph(withDocument(sampleGraph(registry, { sha: "ef".repeat(32), filename: "page.html" }), { sha: "ef".repeat(32), filename: "page.html", url: "https://example.com/page" }))
    render(<DocumentNote action="build the index" />)
    const again = await screen.findByRole("button", { name: "Fetch again" })
    expect(screen.getByTestId("document-note").textContent).toContain("Too many links")
    expect(screen.getByRole("button", { name: "Pick a file or link" })).toBeTruthy()
    refuseLink = false
    fireEvent.click(again)
    await waitFor(() => expect(screen.queryByTestId("document-note")).toBeNull())
    expect(linkCalls).toBe(2)
  })

  it("off the demo, fetches nothing until asked", async () => {
    storeGraph(withDocument(sampleGraph(registry, { sha: "ef".repeat(32), filename: "page.html" }), { sha: "ef".repeat(32), filename: "page.html", url: "https://example.com/page" }))
    render(<DocumentNote action="build the index" />)
    fireEvent.click(await screen.findByRole("button", { name: "Fetch again" }))
    await waitFor(() => expect(screen.queryByTestId("document-note")).toBeNull())
    expect(linkCalls).toBe(1)
  })

  it("keeps the old note for a document with no link", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toContain("Pick a document above")
    expect(linkCalls).toBe(0)
  })
})
