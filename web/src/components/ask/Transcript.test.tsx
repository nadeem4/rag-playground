import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchJson from "@/api/fixtures/output.search.json"
import type { Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry, RetrievalResult } from "@/api/types"
import { rowsFromResult } from "@/components/inspectors/hits"
import { sampleGraph, setReranker, type PipelineGraph } from "@/state/graph"
import { resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"

import { AskPanel, type AskPanelProps } from "./AskPanel"
import { askSnapshot, goldRank, logEntry, type AskSnapshot, type TranscriptEntry } from "./Transcript"

const LIVE = liveRegistry as unknown as Registry
const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null }
const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
const UPLOAD = { sha: "ab".repeat(32), filename: "report.pdf" }
const hybrid = hybridJson as unknown as RetrievalResult
const CARD = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "b",
  shows: "s",
  stresses: "chunk",
  pages: 3,
  default: true,
  filename: SAMPLE.filename,
  sha: SAMPLE.sha,
  question: "What does overlap cost?",
}
// The gold answer sits in the first hybrid hit, across a line break the parser kept.
const QUESTIONS = [{ id: "q1", question: "What does overlap cost?", gold_answer: "Overlap protects answers that   straddle a boundary" }]

/** The hybrid result reranked: the sixth hit first. Prior ranks 6, 1, 2, 4, 3. */
function reranked(): RetrievalResult {
  const order = [5, 0, 1, 3, 2]
  return { ...hybrid, hits: order.map((i, k) => ({ ...hybrid.hits[i], rank: k + 1, prior_rank: hybrid.hits[i].rank })) }
}

beforeEach(() => {
  resetSampleQuestionsCache()
  window.localStorage.clear()
  resetPipelinesForTests()
  const payloads: Record<string, unknown> = { idx1: { doc_count: 6 }, ret1: hybrid, rr1: reranked(), out1: searchJson }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      const payload = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (payload && payloads[payload[1]] !== undefined) return ok(payloads[payload[1]])
      if (url === "/api/samples") return ok([CARD])
      if (url === "/api/samples/chunking-primer/questions") return ok(QUESTIONS)
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("goldRank", () => {
  it("finds the first piece that holds the gold, whitespace and case aside", () => {
    expect(goldRank(rowsFromResult(hybrid), ["overlap protects answers that straddle a boundary"])).toBe(1)
    expect(goldRank(rowsFromResult(reranked()), ["Overlap protects answers"])).toBe(2)
    expect(goldRank(rowsFromResult(hybrid), ["not in the document"])).toBeNull()
    expect(goldRank(rowsFromResult(hybrid), [])).toBeNull()
  })
})

describe("logEntry", () => {
  it("keeps one entry per run, frozen except for a gold rank filled in later", () => {
    const e: TranscriptEntry = { runId: "r1", question: "q", pipeline: "Working copy", reranker: "Cross-encoder", rows: [{ rank: 1, text: "t" }], found: null }
    const once = logEntry([], e)
    expect(once).toEqual([e])
    expect(logEntry(once, { ...e })).toBe(once)
    // Other settings never rewrite a logged run.
    expect(logEntry(once, { ...e, reranker: "no rerank", pipeline: "Other" })).toBe(once)
    // The gold rank may arrive later, and only that is filled in.
    expect(logEntry(once, { ...e, reranker: "no rerank", found: 1 })).toEqual([{ ...e, found: 1 }])
    const found = logEntry(once, { ...e, found: 1 })
    expect(logEntry(found, { ...e, found: 3 })).toBe(found)
    expect(logEntry(once, { ...e, runId: "r2" })).toHaveLength(2)
  })
})

const done = (id: string, artifact_id: string): NodeState => ({ id, status: "done", artifact_id })

/** The panel with the transcript kept in state, as Build keeps it. */
function Harness(p: Omit<AskPanelProps, "transcript" | "onLog">) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  return <AskPanel {...p} transcript={entries} onLog={(e) => setEntries((t) => logEntry(t, e))} />
}

/** The snapshot Build takes when Ask is pressed on `graph`, for run `runId`. */
const snap = (graph: PipelineGraph, runId: string, pipeline = "Working copy"): AskSnapshot => ({ ...askSnapshot(graph, LIVE, pipeline), runId })

function base(graph: PipelineGraph, results: Record<string, NodeState>, asked: AskSnapshot | null) {
  return {
    graph,
    registry: LIVE,
    results: { index: done("index", "idx1"), ...results },
    stale: new Set<string>(),
    busy: false,
    keys: NO_KEYS,
    server: null,
    explanations: {},
    errors: {},
    keyNotice: null,
    asked,
    comparisonHidden: null,
    onComparison: vi.fn(),
    onConfig: vi.fn(),
    onTransform: vi.fn(),
    onReranker: vi.fn(),
    onUseCase: vi.fn(),
    onAsk: vi.fn(),
  }
}

const RERANKED = { retrieve: done("retrieve", "ret1"), rerank_1: done("rerank_1", "rr1"), use_case: done("use_case", "out1") }
const summary = () => screen.queryByText(/^Earlier questions in this tab/)

describe("the transcript", () => {
  it("grows after a finished run, once per run, and Ask again refills the box", async () => {
    const graph = setReranker(sampleGraph(LIVE, SAMPLE, "What does overlap cost?"), LIVE, "cross_encoder")
    const p = base(graph, RERANKED, null)
    const { rerender } = render(<Harness {...p} />)
    expect(summary()).toBeNull()
    rerender(<Harness {...p} asked={snap(graph, "r2")} />)
    await waitFor(() => expect(summary()?.textContent).toBe("Earlier questions in this tab (1)"))
    // The question set may answer after the run: the entry then gains its gold rank.
    const line = await screen.findByTestId("transcript-line")
    await waitFor(() => expect(line.textContent).toBe("Working copy, Cross-encoder: found at #2"))
    expect(line.className).not.toContain("font-mono")
    expect(within(line).getByText("#2").className).toContain("font-mono")
    const entry = screen.getByTestId("transcript-entry")
    expect(within(entry).getByText("What does overlap cost?")).toBeTruthy()
    // The same run is not logged twice.
    rerender(<Harness {...p} asked={snap(graph, "r2")} busy={false} />)
    expect(summary()?.textContent).toBe("Earlier questions in this tab (1)")
    // Each Ask again names its question, so two entries never share an accessible name.
    fireEvent.click(within(entry).getByRole("button", { name: "Ask again: What does overlap cost?" }))
    expect(p.onConfig).toHaveBeenCalledWith("query", expect.objectContaining({ text: "What does overlap cost?" }))
    rerender(<Harness {...p} asked={snap(graph, "r3")} />)
    await waitFor(() => expect(summary()?.textContent).toBe("Earlier questions in this tab (2)"))
  })

  it("a finished entry keeps the settings its run used when the reranker changes afterwards", async () => {
    const graph = setReranker(sampleGraph(LIVE, SAMPLE, "What does overlap cost?"), LIVE, "cross_encoder")
    const p = base(graph, RERANKED, snap(graph, "r2"))
    const { rerender } = render(<Harness {...p} />)
    await waitFor(() => expect(screen.getByTestId("transcript-line").textContent).toBe("Working copy, Cross-encoder: found at #2"))
    // None removes the rerank node; Retrieve and its result stay fresh, so the rows change.
    const none = setReranker(graph, LIVE, null)
    rerender(<Harness {...p} graph={none} results={{ ...p.results, rerank_1: undefined as never }} />)
    await waitFor(() => expect(screen.getByRole("heading", { name: /in search order$/ })).toBeTruthy())
    expect(screen.getByTestId("transcript-line").textContent).toBe("Working copy, Cross-encoder: found at #2")
    expect(screen.queryByText(/no rerank/)).toBeNull()
    expect(summary()?.textContent).toBe("Earlier questions in this tab (1)")
  })

  it("an upload has no gold, so the entry counts the pieces, and names the saved pipeline", async () => {
    const graph = sampleGraph(LIVE, UPLOAD, "Anything?")
    setCurrentId(savePipeline("Plain hybrid", graph)!.saved.id)
    render(<Harness {...base(graph, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") }, snap(graph, "r9", "Plain hybrid"))} />)
    await waitFor(() => expect(summary()?.textContent).toBe("Earlier questions in this tab (1)"))
    expect(screen.getByText("Plain hybrid, no rerank: 5 pieces")).toBeTruthy()
  })

  it("a run whose settings changed before it finished is not logged, so no entry carries the wrong labels", async () => {
    const graph = setReranker(sampleGraph(LIVE, SAMPLE, "What does overlap cost?"), LIVE, "cross_encoder")
    // Asked with the cross-encoder; None was chosen while the run was going.
    const none = setReranker(graph, LIVE, null)
    const p = base(none, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") }, snap(graph, "r4"))
    render(<Harness {...p} />)
    await waitFor(() => expect(screen.getByRole("heading", { name: /in search order$/ })).toBeTruthy())
    await new Promise((r) => setTimeout(r, 50))
    expect(summary()).toBeNull()
    expect(screen.queryByText(/no rerank/)).toBeNull()
  })

  it("the entry takes the snapshot's labels, not the ones on screen at the finish", async () => {
    const graph = sampleGraph(LIVE, UPLOAD, "Anything?")
    render(<Harness {...base(graph, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") }, snap(graph, "r5", "Named when asked"))} />)
    expect(await screen.findByText("Named when asked, no rerank: 5 pieces")).toBeTruthy()
  })
})
