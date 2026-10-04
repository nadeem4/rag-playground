import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetDocumentForTests } from "@/state/document"
import { resetStoredGraphForTests, sampleGraph, storeGraph } from "@/state/graph"

import { DocumentNote, needsDocument } from "./DocumentNote"

const registry = liveRegistry as unknown as Registry
const SAMPLE_SHA = "cd".repeat(32)
const SAMPLE = { name: "chunking-primer", title: "A primer", blurb: "b", shows: "s", stresses: "chunk", pages: 2, default: true, filename: "chunking-primer.pdf", sha: SAMPLE_SHA, question: "q" }

let demo = false

beforeEach(() => {
  demo = false
  resetAppSettingsForTests()
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") return ok({ demo })
      if (url === "/api/sources") return ok([])
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
  it("says the missing file, what it blocks, and offers Pick a document, as a stale-tone status", async () => {
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toBe("NK_Resume.pdf is missing. Pick a document in the bar above to build the index.Pick a document")
    expect(note.getAttribute("role")).toBe("status")
    for (const c of ["bg-stale-wash", "text-stale"]) expect(note.className).toContain(c)
  })

  it("on the demo, says uploads expire", async () => {
    demo = true
    stored("ef".repeat(32), "NK_Resume.pdf")
    render(<DocumentNote action="build the index" />)
    await waitFor(() =>
      expect(screen.getByTestId("document-note").textContent).toBe(
        "NK_Resume.pdf is missing. Uploads on the demo expire. Pick a document in the bar above to build the index.Pick a document",
      ),
    )
  })

  it("asks for a document when there is none", async () => {
    render(<DocumentNote action="run the evaluation" />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toBe("Pick a document in the bar above to run the evaluation.Pick a document")
    expect(screen.getByRole("button", { name: "Pick a document" })).toBeTruthy()
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

  it("needsDocument is true for no document and a missing one only", () => {
    expect(needsDocument("empty")).toBe(true)
    expect(needsDocument("missing")).toBe(true)
    expect(needsDocument("checking")).toBe(false)
    expect(needsDocument("ready")).toBe(false)
  })
})
