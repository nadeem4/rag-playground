import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import { resetAppSettingsForTests } from "@/api/useDemo"
import type { Registry } from "@/api/types"

import {
  addDocument,
  chooseDocument,
  docStatus,
  documentOf,
  documentsOf,
  loadSampleDocument,
  refetchLink,
  removeDocument,
  resetDocumentForTests,
  setUploadState,
  useDocument,
  withDocument,
  withDocuments,
} from "./document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph, type PipelineGraph } from "./graph"
import { isEdited, readCurrentId, readPipelines, resetPipelinesForTests, sameGraph, savePipeline, STARTER_ID } from "./pipelines"

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
  resetPipelinesForTests()
  registryFails = false
  posts = []
  answers = { "/api/v2/documents": [UP], "/api/samples": [SAMPLE] }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/v2/strategies") {
        if (registryFails) throw new Error("down")
        return ok({ stages: liveRegistry })
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

describe("addDocument and removeDocument", () => {
  const NOTES = ref("ee".repeat(32), "notes.md")

  it("adds a document after the pipeline's own, keeping every setting, and keeps each once", async () => {
    const before = sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf"))
    storeGraph(before)
    await addDocument(NOTES)
    await addDocument(NOTES)
    const after = readStoredGraph(registry)!
    expect(documentsOf(after)).toEqual([ref(SAMPLE_SHA, "chunking-primer.pdf"), NOTES])
    const rest = (g: PipelineGraph) => g.nodes.filter((n) => n.stage !== "source")
    expect(rest(after)).toEqual(rest(before))
  })

  it("refuses another document with the same name: the server tells documents apart by their names", async () => {
    storeGraph(sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf")))
    await addDocument(NOTES)
    await expect(addDocument(ref("ff".repeat(32), "chunking-primer.pdf"))).rejects.toThrow(/already has a document named chunking-primer.pdf/)
    expect(documentsOf(readStoredGraph(registry))).toEqual([ref(SAMPLE_SHA, "chunking-primer.pdf"), NOTES])
  })

  it("replaces the only document when the new one has its name, as an edited file uploaded again", async () => {
    storeGraph(sampleGraph(registry, ref(UP.sha, "report.pdf"), "Who wrote this?"))
    const edited = ref("ff".repeat(32), "report.pdf")
    await addDocument(edited)
    const after = readStoredGraph(registry)!
    expect(documentsOf(after)).toEqual([edited])
    expect(after.nodes.find((n) => n.stage === "query")!.config.text).toBe("Who wrote this?")
  })

  it("picks, as chooseDocument does, when the pipeline has no document yet", async () => {
    await addDocument(ref(SAMPLE_SHA, "chunking-primer.pdf"))
    expect(documentsOf(readStoredGraph(registry))).toEqual([ref(SAMPLE_SHA, "chunking-primer.pdf")])
  })

  it("removes one document and keeps the rest in order", async () => {
    storeGraph(sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf")))
    await addDocument(NOTES)
    await addDocument(ref(UP.sha, UP.filename))
    removeDocument(NOTES.sha)
    expect(documentsOf(readStoredGraph(registry))).toEqual([ref(SAMPLE_SHA, "chunking-primer.pdf"), ref(UP.sha, UP.filename)])
    removeDocument("nope")
    expect(documentsOf(readStoredGraph(registry))).toHaveLength(2)
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
    // The default recipe on a sample is the Starter.
    expect(readCurrentId()).toBe(STARTER_ID)
  })

  it("stores nothing when the registry cannot be read, so the old document stays", async () => {
    registryFails = true
    await expect(chooseDocument(ref(UP.sha, UP.filename))).rejects.toThrow()
    expect(readStoredGraph(registry)).toBeNull()
  })

  it("tells every reader, and never flags the chosen file before the list catches up", async () => {
    storeGraph(sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf")))
    answers["/api/v2/documents"] = []
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(() => chooseDocument(ref(UP.sha, UP.filename)))
    expect(result.current.doc).toEqual(ref(UP.sha, UP.filename))
    expect(result.current.status).toBe("ready")
  })

  describe("leaving a sample for another document", () => {
    const queryText = () => readStoredGraph(registry)!.nodes.find((n) => n.stage === "query")!.config.text
    async function onSample(text: string) {
      answers["/api/samples/chunking-primer/questions"] = [{ id: "q1", question: "What does overlap cost?" }]
      storeGraph(sampleGraph(registry, ref(SAMPLE_SHA, "chunking-primer.pdf"), text))
      const { result } = renderHook(() => useDocument())
      await waitFor(() => expect(result.current.samples).not.toBeNull())
    }

    it("clears the sample's own question, so the upload is not asked about the sample", async () => {
      await onSample(SAMPLE.question)
      await act(() => chooseDocument(ref(UP.sha, UP.filename)))
      expect(queryText()).toBe("")
    })

    it("clears any of the sample's listed questions, such as one picked from its chips", async () => {
      await onSample("What does overlap cost?")
      await act(() => chooseDocument(ref(UP.sha, UP.filename)))
      expect(queryText()).toBe("")
    })

    it("keeps a question the visitor typed", async () => {
      await onSample("Where is the summary table?")
      await act(() => chooseDocument(ref(UP.sha, UP.filename)))
      expect(queryText()).toBe("Where is the summary table?")
    })
  })

  it("lists as Your uploads only the files that are not a sample", async () => {
    answers["/api/v2/documents"] = [UP, { sha: SAMPLE_SHA, filename: "chunking-primer.pdf", size: 1, content_type: "application/pdf" }]
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.uploads?.map((u) => u.sha)).toEqual([UP.sha]))
  })

  it("reads a list that is not an array as failed: never a crash, and never amber without the uploads", async () => {
    storeGraph(sampleGraph(registry, ref("ef".repeat(32), "NK_Resume.pdf")))
    answers["/api/v2/documents"] = { source: "none" }
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

  it("does nothing while an upload runs, so the two cannot race", async () => {
    storeGraph(sampleGraph(registry, ref(UP.sha, UP.filename)))
    setUploadState({ uploading: "big.pdf" })
    await loadSampleDocument(SAMPLE)
    expect(posts).toEqual([])
    expect(documentOf(readStoredGraph(registry))).toEqual(ref(UP.sha, UP.filename))
  })
})

describe("the last upload's error", () => {
  it("is cleared once a document is chosen", async () => {
    setUploadState({ uploadError: "Upload of a.txt failed: Only PDF files can be uploaded." })
    const { result } = renderHook(() => useDocument())
    expect(result.current.uploadError).not.toBeNull()
    await act(() => chooseDocument(ref(UP.sha, UP.filename)))
    expect(result.current.uploadError).toBeNull()
  })
})

describe("a sample saved with an old fingerprint", () => {
  const OLD = "ab".repeat(32)
  const NOTE = "The sample chunking-primer.pdf was updated, so this page now uses its current copy."

  it("switches to the sample's current copy once the lists load, reads ready, and says so once", async () => {
    storeGraph(sampleGraph(registry, ref(OLD, "chunking-primer.pdf")))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.doc).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf")))
    expect(result.current.status).toBe("ready")
    await waitFor(() => expect(result.current.recoveredNote).toBe(NOTE))
    // The note clears after the next document choice.
    await act(() => chooseDocument(ref(UP.sha, UP.filename)))
    expect(result.current.recoveredNote).toBeNull()
  })

  it("keeps the question you typed: only the fingerprint changes", async () => {
    storeGraph(sampleGraph(registry, ref(OLD, "chunking-primer.pdf"), "Who wrote this?"))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.doc).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf")))
    await waitFor(() => expect(result.current.recoveredNote).toBe(NOTE))
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "query")!.config.text).toBe("Who wrote this?")
  })

  it("leaves an upload missing, even when an upload in this browser has a sample's filename", async () => {
    const twin = { ...UP, sha: "77".repeat(32), filename: "chunking-primer.pdf" }
    answers["/api/v2/documents"] = [twin]
    storeGraph(sampleGraph(registry, ref(OLD, "chunking-primer.pdf")))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("missing"))
    await act(async () => {})
    expect(result.current.doc).toEqual(ref(OLD, "chunking-primer.pdf"))
    expect(result.current.recoveredNote).toBeNull()
  })

  it("never matches a file whose name is not exactly a sample's", async () => {
    storeGraph(sampleGraph(registry, ref(OLD, "Chunking-Primer.pdf")))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("missing"))
    await act(async () => {})
    expect(result.current.recoveredNote).toBeNull()
  })

  it("recovers when a saved pipeline with the old fingerprint is opened later", async () => {
    storeGraph(sampleGraph(registry, ref(UP.sha, UP.filename)))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await waitFor(() => expect(result.current.samples).not.toBeNull())
    act(() => storeGraph(sampleGraph(registry, ref(OLD, "chunking-primer.pdf"))))
    await waitFor(() => expect(result.current.doc).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf")))
    expect(result.current.status).toBe("ready")
    await waitFor(() => expect(result.current.recoveredNote).toBe(NOTE))
  })

  it("a saved pipeline opened on the old fingerprint follows the current copy, so it does not open as edited (M7)", async () => {
    const opened = sampleGraph(registry, ref(OLD, "chunking-primer.pdf"))
    const { saved } = savePipeline("Migrated", opened)!
    storeGraph(opened)
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.recoveredNote).toBe(NOTE))
    const p = readPipelines().find((x) => x.id === saved.id)!
    expect(p.documents).toEqual([ref(SAMPLE_SHA, "chunking-primer.pdf")])
    expect(isEdited(p, readStoredGraph(registry)!)).toBe(false)
  })

  it.each([
    ["first", (stale: { sha: string; filename: string }, other: { sha: string; filename: string }) => [stale, other]],
    ["second", (stale: { sha: string; filename: string }, other: { sha: string; filename: string }) => [other, stale]],
  ])("swaps a stale sample in %s place for its current copy and keeps the other documents", async (_place, order) => {
    const stale = ref(OLD, "chunking-primer.pdf")
    const notes = ref(UP.sha, UP.filename)
    storeGraph(withDocuments(sampleGraph(registry, ref(UP.sha, UP.filename)), order(stale, notes)))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.recoveredNote).toBe(NOTE))
    expect(documentsOf(readStoredGraph(registry))).toEqual(order(ref(SAMPLE_SHA, "chunking-primer.pdf"), notes))
  })

  it("swaps every stale sample of a pipeline at once, and names them all", async () => {
    const OTHER_OLD = "ef".repeat(32)
    const OTHER = { ...SAMPLE, name: "tables", filename: "tables.pdf", sha: "fe".repeat(32), default: false }
    answers["/api/samples"] = [SAMPLE, OTHER]
    const notes = ref(UP.sha, UP.filename)
    storeGraph(withDocuments(sampleGraph(registry, notes), [ref(OLD, "chunking-primer.pdf"), notes, ref(OTHER_OLD, "tables.pdf")]))
    const { saved } = savePipeline("Two samples", readStoredGraph(registry)!)!
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.recoveredNote).not.toBeNull())
    const now = [ref(SAMPLE_SHA, "chunking-primer.pdf"), notes, ref(OTHER.sha, "tables.pdf")]
    expect(documentsOf(readStoredGraph(registry))).toEqual(now)
    expect(result.current.status).toBe("ready")
    expect(result.current.recoveredNote).toBe("The samples chunking-primer.pdf and tables.pdf were updated, so this page now uses their current copies.")
    expect(readPipelines().find((x) => x.id === saved.id)!.documents).toEqual(now)
  })

  it("does nothing while the lists are still loading", async () => {
    let release: () => void = () => {}
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const inner = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/samples" ? new Promise((resolve) => (release = () => resolve(inner(url, init)))) : inner(url, init),
    )
    storeGraph(sampleGraph(registry, ref(OLD, "chunking-primer.pdf")))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.uploads).not.toBeNull())
    await act(async () => {})
    expect(result.current.status).toBe("checking")
    expect(result.current.doc).toEqual(ref(OLD, "chunking-primer.pdf"))
    expect(result.current.recoveredNote).toBeNull()
    act(() => release())
    await waitFor(() => expect(result.current.doc).toEqual(ref(SAMPLE_SHA, "chunking-primer.pdf")))
  })
})

describe("a link document whose stored copy is gone", () => {
  const OLD = "ef".repeat(32)
  const NEW = "34".repeat(32)
  const LINKED = { sha: OLD, filename: "page.html", url: "https://example.com/page" }
  const FETCHED = { sha: NEW, filename: "page.html", size: 9, content_type: "text/html", origin_url: "https://example.com/page" }
  let refetches: unknown[]
  let refuse: boolean
  let demo: boolean

  beforeEach(() => {
    refetches = []
    refuse = false
    demo = true
    resetAppSettingsForTests()
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/settings/app") return new Response(JSON.stringify({ demo }), { status: 200 })
        if (url === "/api/v2/documents/url") {
          const asked = JSON.parse(String(init?.body)) as { url: string }
          refetches.push(asked)
          const fetched = asked.url.endsWith("/other") ? { ...FETCHED, sha: "88".repeat(32), filename: "other.html", origin_url: asked.url } : FETCHED
          return refuse ? new Response(JSON.stringify({ detail: "Too many links" }), { status: 429 }) : new Response(JSON.stringify(fetched), { status: 200 })
        }
        return base(url, init)
      }),
    )
    storeGraph(withDocument(sampleGraph(registry, ref(OLD, "page.html")), LINKED))
  })

  it("fetches the link again and swaps in the new sha", async () => {
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.doc?.sha).toBe(NEW))
    expect(refetches).toEqual([{ url: "https://example.com/page" }])
    expect(documentOf(readStoredGraph(registry))).toEqual({ sha: NEW, filename: "page.html", url: "https://example.com/page" })
    expect(result.current.status).toBe("ready")
  })

  it("keeps it missing when the fetch is refused, and fetches again on request", async () => {
    refuse = true
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.refused.has(OLD)).toBe(true))
    expect(result.current.status).toBe("missing")
    expect(refetches).toHaveLength(1)
    refuse = false
    await act(async () => void (await refetchLink(LINKED)))
    await waitFor(() => expect(result.current.doc?.sha).toBe(NEW))
    expect(result.current.refused.has(OLD)).toBe(false)
  })

  it("keeps a saved pipeline's document in step, link and pin included, so it does not open as edited", async () => {
    const pinned = { ...LINKED, category: "text" }
    const g = withDocument(sampleGraph(registry, ref(OLD, "page.html")), pinned)
    const { saved } = savePipeline("Linked", g)!
    storeGraph(g)
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.doc?.sha).toBe(NEW))
    const p = readPipelines().find((x) => x.id === saved.id)!
    expect(p.documents).toEqual([{ sha: NEW, filename: "page.html", url: LINKED.url, category: "text" }])
    expect(isEdited(p, readStoredGraph(registry)!)).toBe(false)
  })

  it("fetches nothing by itself off the demo, and fetches when asked", async () => {
    demo = false
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.refused.has(OLD)).toBe(true))
    expect(refetches).toEqual([])
    expect(result.current.status).toBe("missing")
    await act(async () => void (await refetchLink(LINKED)))
    await waitFor(() => expect(result.current.doc?.sha).toBe(NEW))
    expect(refetches).toHaveLength(1)
  })

  it("keeps the server's sentence when a fetch is refused", async () => {
    refuse = true
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.refused.get(OLD)).toBe("Too many links"))
  })

  it("fetches two link documents again when both are gone", async () => {
    const two = { sha: "99".repeat(32), filename: "other.html", url: "https://example.com/other" }
    storeGraph(withDocuments(sampleGraph(registry, ref(OLD, "page.html")), [LINKED, two]))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.documents.map((d) => d.sha)).toEqual([NEW, "88".repeat(32)]))
    expect(refetches).toHaveLength(2)
    expect(result.current.documents.map((d) => d.url)).toEqual([LINKED.url, two.url])
  })

  it("leaves a document with no link missing, and asks for nothing", async () => {
    storeGraph(withDocument(sampleGraph(registry, ref(OLD, "page.html")), ref(OLD, "page.html")))
    const { result } = renderHook(() => useDocument())
    await waitFor(() => expect(result.current.status).toBe("missing"))
    expect(refetches).toEqual([])
  })
})
