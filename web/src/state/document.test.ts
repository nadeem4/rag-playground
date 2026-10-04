import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { chooseDocument, docStatus, documentOf, loadSampleDocument, resetDocumentForTests, useDocument, withDocument } from "./document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph, type PipelineGraph } from "./graph"
import { sameGraph } from "./pipelines"

const registry = liveRegistry as unknown as Registry
const SAMPLE_SHA = "cd".repeat(32)
const UP = { sha: "12".repeat(32), filename: "my-notes.pdf", size: 7451, content_type: "application/pdf" }
const SAMPLE = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "b",
  shows: "s",
  stresses: "chunk" as const,
  pages: 2,
  default: true,
  filename: "chunking-primer.pdf",
  sha: SAMPLE_SHA,
  question: "Why do chunk boundaries matter?",
}
const ref = (sha: string, filename = "x.pdf") => ({ sha, filename })

let answers: Record<string, unknown>
let registryFails = false
let posts: { url: string; body: unknown }[] = []

beforeEach(() => {
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  registryFails = false
  posts = []
  answers = { "/api/sources": [UP], "/api/samples": [SAMPLE] }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/registry") {
        if (registryFails) throw new Error("down")
        return ok(liveRegistry)
      }
      if (url === "/api/sources/sample" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return ok({ sha: SAMPLE_SHA, filename: "chunking-primer.pdf", size: 1, content_type: "application/pdf" })
      }
      if (url in answers) return ok(answers[url])
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("documentOf and withDocument", () => {
  it("reads the source node's file, and sets only it", () => {
    const g = sampleGraph(registry, ref(UP.sha, UP.filename))
    expect(documentOf(g)).toEqual(ref(UP.sha, UP.filename))
    const next = withDocument(g, ref(SAMPLE_SHA, "chunking-primer.pdf"))
    expect(documentOf(next)).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf"))
    expect(next.nodes.filter((n) => n.stage !== "source")).toEqual(g.nodes.filter((n) => n.stage !== "source"))
  })

  it("is null without a file", () => {
    const g = withDocument(sampleGraph(registry, ref(UP.sha)), ref("", ""))
    expect(documentOf(g)).toBeNull()
  })
})

describe("docStatus", () => {
  it("is empty with no document", () => {
    expect(docStatus(null, [], [SAMPLE], false, new Set())).toBe("empty")
  })
  it("is checking until the uploads answer and the samples answer or fail", () => {
    expect(docStatus(ref("ef".repeat(32)), null, [SAMPLE], false, new Set())).toBe("checking")
    expect(docStatus(ref("ef".repeat(32)), [UP], null, false, new Set())).toBe("checking")
  })
  it("is ready for a listed upload, a sample, or a file chosen on this page", () => {
    expect(docStatus(ref(UP.sha), [UP], [SAMPLE], false, new Set())).toBe("ready")
    expect(docStatus(ref(SAMPLE_SHA), [], [SAMPLE], false, new Set())).toBe("ready")
    expect(docStatus(ref("ef".repeat(32)), [], [SAMPLE], false, new Set(["ef".repeat(32)]))).toBe("ready")
  })
  it("is missing once both lists answered without it, a failed samples list counting as none", () => {
    expect(docStatus(ref("ef".repeat(32)), [UP], null, true, new Set())).toBe("missing")
  })
})

describe("chooseDocument", () => {
  it("keeps every setting of a pipeline that has a document, and takes a sample's question", async () => {
    const before = sampleGraph(registry, ref(UP.sha, UP.filename))
    storeGraph(before)
    await chooseDocument(ref(SAMPLE_SHA, "chunking-primer.pdf"), SAMPLE.question)
    const after = readStoredGraph(registry)!
    expect(documentOf(after)).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf"))
    expect(after.nodes.find((n) => n.stage === "query")!.config.text).toBe(SAMPLE.question)
    const rest = (g: PipelineGraph) => g.nodes.filter((n) => n.stage !== "source" && n.stage !== "query")
    expect(rest(after)).toEqual(rest(before))
  })

  it("builds the sample pipeline when there is no document yet", async () => {
    await chooseDocument(ref(SAMPLE_SHA, "chunking-primer.pdf"), SAMPLE.question)
    expect(sameGraph(readStoredGraph(registry)!, sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf"), SAMPLE.question))).toBe(true)
  })

  it("stores nothing when the registry cannot be read, so the old document stays", async () => {
    registryFails = true
    await expect(chooseDocument(ref(UP.sha, UP.filename))).rejects.toThrow()
    expect(readStoredGraph(registry)).toBeNull()
  })

  it("tells every reader, and never flags the chosen file before the list catches up", async () => {
    storeGraph(sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf")))
    answers["/api/sources"] = []
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(() => chooseDocument(ref(UP.sha, UP.filename)))
    expect(result.current.doc).toEqual(ref(UP.sha, UP.filename))
    expect(result.current.status).toBe("ready")
  })

  it("lists as Your uploads only the files that are not a sample", async () => {
    answers["/api/sources"] = [UP, { sha: SAMPLE_SHA, filename: "chunking-primer.pdf", size: 1, content_type: "application/pdf" }]
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.uploads?.map((u) => u.sha)).toEqual([UP.sha]))
  })

  it("reads a list that is not an array as failed: never a crash, and never amber without the uploads", async () => {
    storeGraph(sampleGraph(registry, ref("ef".repeat(32), "NK_Resume.pdf")))
    answers["/api/sources"] = { source: "none" }
    answers["/api/samples"] = { source: "none" }
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.listError).toBe(true))
    expect(result.current.status).toBe("checking")
    expect(result.current.uploads).toBeNull()
  })
})

describe("loadSampleDocument", () => {
  it("loads the sample on the server, then sets its file and its question", async () => {
    storeGraph(sampleGraph(registry, ref(UP.sha, UP.filename)))
    await loadSampleDocument(SAMPLE)
    expect(posts).toEqual([{ url: "/api/sources/sample", body: { name: "chunking-primer" } }])
    const g = readStoredGraph(registry)!
    expect(documentOf(g)).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf"))
    expect(g.nodes.find((n) => n.stage === "query")!.config.text).toBe(SAMPLE.question)
  })
})
