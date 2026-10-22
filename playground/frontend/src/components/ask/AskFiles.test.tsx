import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FIND_GOLD_URL, findGoldResponse } from "@/api/fixtures/findGold"
import liveRegistry from "@/api/fixtures/registry.json"
import chunkJson from "@/api/fixtures/chunk_set.recursive_character.json"
import parsedJson from "@/api/fixtures/parsed_doc.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchJson from "@/api/fixtures/output.search.json"
import chatJson from "@/api/fixtures/output.chat.json"
import type { Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { ChatOutput, Registry, RetrievalResult } from "@/api/types"
import type { SearchOutput } from "@/components/inspectors/hits"
import { withDocuments } from "@/state/document"
import { sampleGraph, setUseCase, type PipelineGraph } from "@/state/graph"

import { AskPanel, type AskPanelProps } from "./AskPanel"
import { resetMotionMemory } from "./AskResults"

/*
 * The Ask results on a pipeline with several documents: each hit names its
 * file, the document view opens the hit's own file, the finding sentence and
 * a model answer's sources name files. With one document nothing of it shows.
 */

const LIVE = liveRegistry as unknown as Registry
const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null, openrouter: null }
const hybrid = hybridJson as unknown as RetrievalResult
const search = searchJson as unknown as SearchOutput
const chat = chatJson as unknown as ChatOutput

/** The fixtures' own document, and a second one that ranks 2 and 4 come from. */
const PRIMER = { sha: hybrid.hits[0].chunk.doc_id, filename: "chunking-notes.pdf" }
const GUIDE = { sha: "ef".repeat(32), filename: "field-guide.docx" }
const FROM_GUIDE = new Set([2, 4])

const twoDocs = (): RetrievalResult => ({
  ...hybrid,
  hits: hybrid.hits.map((h) => (FROM_GUIDE.has(h.rank) ? { ...h, chunk: { ...h.chunk, id: `g${h.chunk.id}`, doc_id: GUIDE.sha } } : h)),
})
const twoDocSearch = (): SearchOutput => ({
  ...search,
  payload: { ...search.payload, results: search.payload.results!.map((r) => (FROM_GUIDE.has(r.rank) ? { ...r, chunk_id: `g${r.chunk_id}`, doc_id: GUIDE.sha } : r)) },
})

let payloads: Record<string, unknown>

beforeEach(() => {
  resetMotionMemory()
  resetSampleQuestionsCache()
  payloads = {
    idx1: { doc_count: 12 },
    ret1: hybrid,
    ret2: twoDocs(),
    out1: search,
    out2: twoDocSearch(),
    docA: parsedJson,
    docB: { ...parsedJson, filename: GUIDE.filename, source_id: GUIDE.sha },
    chA: chunkJson,
    chB: { ...chunkJson, doc_id: GUIDE.sha, chunks: chunkJson.chunks.map((c) => ({ ...c, id: `g${c.id}`, doc_id: GUIDE.sha })) },
    chat2: {
      ...chat,
      payload: { ...chat.payload, citations: chat.payload.citations.map((c) => (c.n === 2 ? { ...c, source_sha: GUIDE.sha } : c)) },
    },
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === FIND_GOLD_URL) return findGoldResponse(init)
      const payload = /^\/api\/v2\/results\/([^/]+)\/payload$/.exec(url)
      if (payload && payloads[payload[1]] !== undefined) return ok(payloads[payload[1]])
      if (url === "/api/samples") return ok([])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const done = (id: string, artifact_id: string): NodeState => ({ id, status: "done", artifact_id })

/** Each step before the index ran once per document; the shown document is the first. */
function perDocument(graph: PipelineGraph, several: boolean): Record<string, NodeState> {
  const out: Record<string, NodeState> = {}
  for (const n of graph.nodes) {
    const ids = n.stage === "chunk" ? ["chA", "chB"] : n.stage === "parse" || n.stage === "clean" ? ["docA", "docB"] : null
    if (!ids) continue
    out[n.id] = {
      ...done(n.id, ids[0]),
      ...(several ? { documents: { [PRIMER.filename]: { status: "done", artifact_id: ids[0] }, "field-guide_docx": { status: "done", artifact_id: ids[1] } } } : {}),
    }
  }
  return out
}

function props(graph: PipelineGraph, results: Record<string, NodeState>): AskPanelProps {
  return {
    graph,
    registry: LIVE,
    results: { index: done("index", "idx1"), ...results },
    stale: new Set(),
    busy: false,
    keys: NO_KEYS,
    server: null,
    explanations: {},
    errors: {},
    keyNotice: null,
    asked: null,
    transcript: [],
    comparisonHidden: null,
    onComparison: vi.fn(),
    onLog: vi.fn(),
    onConfig: vi.fn(),
    onTransform: vi.fn(),
    onReranker: vi.fn(),
    onUseCase: vi.fn(),
    onRewrite: vi.fn(),
    onAsk: vi.fn(),
  }
}

const both = (question?: string) => withDocuments(sampleGraph(LIVE, PRIMER, question), [PRIMER, GUIDE])
const one = (question?: string) => sampleGraph(LIVE, PRIMER, question)
const SEARCHED = { retrieve: done("retrieve", "ret2"), use_case: done("use_case", "out2") }
const slip = (rank: number) => document.querySelector(`[data-hit-row="${rank}"]`) as HTMLElement
const tags = () => [...document.querySelectorAll("[data-hit-row] [data-file-tag]")].map((t) => t.textContent)

describe("hits from several documents", () => {
  it("name their file on the meta line, with the file's colour dot", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} />)
    await waitFor(() => expect(tags()).toEqual(["chunking-notes.pdf", "field-guide.docx", "chunking-notes.pdf", "field-guide.docx", "chunking-notes.pdf"]))
    const tag = within(within(slip(2)).getByTestId("meta")).getByText("field-guide.docx").closest("[data-file-tag]") as HTMLElement
    expect((tag.querySelector("[data-file-dot]") as HTMLElement).style.background).toBe("var(--file-2)")
    // A piece from the other file keeps the number it has in its own file's chunk set.
    const own = chunkJson.chunks.findIndex((c) => `g${c.id}` === (payloads.out2 as SearchOutput).payload.results![1].chunk_id)
    await waitFor(() => expect(within(slip(2)).getByRole("img").getAttribute("aria-label")).toBe(`Chunk ${own + 1}`))
  })

  it("name no file with one document: the slips stay as they are", async () => {
    render(<AskPanel {...props(one(), { ...perDocument(one(), false), retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    await waitFor(() => expect(document.querySelectorAll("[data-hit-row]")).toHaveLength(5))
    expect(document.querySelector("[data-file-tag]")).toBeNull()
    expect(screen.getByTestId("finding-sentence").textContent).toMatch(/^The closest piece says: /)
  })

  it("open their own document: Show in text on a piece from the second file shows that file", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} />)
    const show = await waitFor(() => within(slip(2)).getByRole("button", { name: "Show in text" }))
    // A piece from the PDF still opens its page.
    expect(within(slip(1)).getByRole("button", { name: "Show in PDF" })).toBeTruthy()
    fireEvent.click(show)
    const picker = (await screen.findByLabelText("Showing")) as HTMLSelectElement
    expect(picker.value).toBe(GUIDE.sha)
    expect([...picker.options].map((o) => o.textContent)).toEqual(["chunking-notes.pdf", "field-guide.docx"])
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/v2/results/docB/payload")).toBe(true))
    expect(await screen.findByText("Rank 2")).toBeTruthy()
  })

  it("open their own document when the piece itself is clicked, and the picker switches files", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} />)
    await waitFor(() => expect(slip(4)).toBeTruthy())
    fireEvent.click(slip(4))
    const picker = (await screen.findByLabelText("Showing")) as HTMLSelectElement
    expect(picker.value).toBe(GUIDE.sha)
    expect(await screen.findByText("Rank 4")).toBeTruthy()
    // Picking the other file opens its best piece in these results.
    fireEvent.change(picker, { target: { value: PRIMER.sha } })
    expect(await screen.findByText("Rank 1")).toBeTruthy()
  })

  it("say the file in the finding sentence", async () => {
    render(<AskPanel {...props(both("Who wrote this?"), { ...perDocument(both(), true), ...SEARCHED })} />)
    const p = await screen.findByTestId("finding-sentence")
    expect(p.textContent).toMatch(/^The closest piece, from chunking-notes\.pdf, says: /)
    expect(p.querySelector("[data-file-tag]")).toBeTruthy()
  })
})

describe("a model answer over several documents", () => {
  it("names the files its cited pieces came from, under the answer", async () => {
    const g = setUseCase(both(), LIVE, "chat")
    render(<AskPanel {...props(g, { ...perDocument(g, true), retrieve: done("retrieve", "ret2"), use_case: done("use_case", "chat2") })} />)
    const sources = await screen.findByTestId("answer-sources")
    expect(sources.textContent).toBe("Sources: chunking-notes.pdf field-guide.docx")
    const answer = document.querySelector("[data-chat-inspector]") as HTMLElement
    expect(answer.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("has no Sources line with one document", async () => {
    const g = setUseCase(one(), LIVE, "chat")
    render(<AskPanel {...props(g, { ...perDocument(g, false), retrieve: done("retrieve", "ret1"), use_case: done("use_case", "chat2") })} />)
    await waitFor(() => expect(document.querySelector("[data-chat-inspector]")).toBeTruthy())
    expect(screen.queryByTestId("answer-sources")).toBeNull()
  })
})

describe("Search in moved after the results", () => {
  const shown = () => document.querySelectorAll("[data-hit-row]").length

  it("marks results searched over all documents out of date once one file is chosen", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} searchIn={GUIDE.sha} askedIn={null} />)
    const note = await screen.findByTestId("stale-results")
    expect(note.textContent).toBe("You changed where to search. Ask again to search field-guide.docx only.")
    expect(shown()).toBe(0)
    expect(screen.getByRole("button", { name: "Ask" }).className.split(/\s+/)).toContain("ring-accent-wash")
  })

  it("marks results from one file out of date once all documents are chosen again", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} searchIn={null} askedIn={GUIDE.sha} />)
    expect((await screen.findByTestId("stale-results")).textContent).toBe("You changed where to search. Ask again to search all 2 documents.")
  })

  it("keeps results searched where Search in still points", async () => {
    render(<AskPanel {...props(both(), { ...perDocument(both(), true), ...SEARCHED })} searchIn={GUIDE.sha} askedIn={GUIDE.sha} />)
    await waitFor(() => expect(shown()).toBe(5))
    expect(screen.queryByTestId("stale-results")).toBeNull()
  })

  it("logs which file an earlier question searched, and the transcript says so", async () => {
    const onLog = vi.fn()
    const asked = { runId: "r1", question: "q", pipeline: "Working copy", reranker: "no rerank", signature: "", searchIn: GUIDE.filename }
    const p = props(both("q"), { ...perDocument(both(), true), ...SEARCHED })
    const { rerender } = render(<AskPanel {...p} onLog={onLog} asked={{ ...asked, signature: "x" }} />)
    // The snapshot's signature must match the settings for the run to be logged: take it from the panel's own graph.
    const { askSignature } = await import("./Transcript")
    rerender(<AskPanel {...p} onLog={onLog} asked={{ ...asked, signature: askSignature(p.graph, p.registry) }} />)
    await waitFor(() => expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", searchIn: GUIDE.filename })))
    cleanup()
    render(<AskPanel {...p} transcript={[{ runId: "r1", question: "q", pipeline: "Working copy", reranker: "no rerank", rows: [{ rank: 1, text: "t" }], found: null, searchIn: GUIDE.filename }]} />)
    expect(screen.getByTestId("transcript-line").textContent).toBe("Working copy, no rerank, in field-guide.docx only: 1 piece")
  })
})
