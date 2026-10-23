import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import searchJson from "@/api/fixtures/output.search.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import { ApiKeyProvider, useApiKey, type Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry } from "@/api/types"
import { withDocuments } from "@/state/document"
import { e2eSampleGraph, sampleGraph, setReranker, setRewrite, setUseCase, type PipelineGraph } from "@/state/graph"

import { AskPanel, type AskPanelProps } from "./AskPanel"

/** A start time `ago` seconds before a frozen clock, so a slow machine cannot tick the shown seconds over. */
const FROZEN_MS = 1_800_000_000_000
function startedAgo(ago: number): number {
  vi.useFakeTimers({ now: FROZEN_MS, toFake: ["Date"] })
  return FROZEN_MS / 1000 - ago
}
afterEach(() => vi.useRealTimers())


const LIVE = liveRegistry as unknown as Registry
const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null, openrouter: null }
const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
const UPLOAD = { sha: "ab".repeat(32), filename: "report.pdf" }
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
  question: "Why do chunk boundaries matter?",
}
const QUESTIONS = [
  { id: "q1", question: "What is a chunk?", gold_answer: "a" },
  { id: "q2", question: "Why overlap?", gold_answer: "b" },
]

beforeEach(() => {
  resetSampleQuestionsCache()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/samples") return ok([CARD])
      if (url === "/api/samples/chunking-primer/questions") return ok(QUESTIONS)
      if (url === "/api/v2/results/idx1/payload") return ok({ doc_count: 42 })
      if (url === "/api/v2/results/doc1/payload") return ok({ page_count: 0, elements: [], filename: "field-guide.docx" })
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const INDEX_DONE: Record<string, NodeState> = { index: { id: "index", status: "done", artifact_id: "idx1" } }

function setup(over: Partial<AskPanelProps> = {}) {
  const props: AskPanelProps = {
    graph: sampleGraph(LIVE, SAMPLE),
    registry: LIVE,
    results: INDEX_DONE,
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
    ...over,
  }
  render(
    <ApiKeyProvider>
      <KeyPanelProbe />
      <AskPanel {...props} />
    </ApiKeyProvider>,
  )
  return props
}

/** Shows whether the header's key panel was asked to open. */
function KeyPanelProbe() {
  return <span data-testid="key-panel">{String(useApiKey().panelOpen)}</span>
}

const askButton = () => screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement

describe("the Ask button tooltip", () => {
  it("says what Ask runs", async () => {
    setup()
    await waitFor(() => expect(askButton().disabled).toBe(false))
    expect(askButton().getAttribute("title")).toBe("Runs retrieval, reranking and the answer on the built index, with the settings below.")
  })
})

const question = () => screen.getByLabelText("Question") as HTMLTextAreaElement

describe("the question box", () => {
  it("takes at most 2,000 characters, the server's limit", () => {
    setup()
    expect(question().maxLength).toBe(2000)
  })
})

describe("finding the answer", () => {
  const ANSWERED = { ...INDEX_DONE, use_case: { id: "use_case", status: "done" as const, artifact_id: "out1" } }
  const HINT = "Change a setting below, such as the search or the reranker, and ask again to see the pieces move."
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it("the answer sits right under the question, above the sample's chips and the settings", async () => {
    setup({ results: ANSWERED })
    await screen.findByRole("button", { name: "Why overlap?" })
    const answer = screen.getByTestId("ask-answer")
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(question(), answer)).toBe(true)
    expect(follows(answer, screen.getByText("Try one of the sample's questions:"))).toBe(true)
    expect(follows(answer, screen.getByTestId("recipe"))).toBe(true)
  })

  it("when Asking turns back into Ask, the panel brings the answer into view", () => {
    const into = vi.fn()
    HTMLElement.prototype.scrollIntoView = into
    const p = setup({ results: INDEX_DONE, asking: true, busy: true })
    expect(into).not.toHaveBeenCalled()
    cleanup()
    const { rerender } = render(<AskPanel {...p} />)
    rerender(<AskPanel {...p} asking={false} busy={false} results={ANSWERED} />)
    expect(into).toHaveBeenCalledTimes(1)
    expect(into.mock.contexts[0]).toBe(screen.getByTestId("ask-answer"))
  })

  it("right under a fresh answer, invites a change of search or reranker, and its button opens the settings and goes to them", async () => {
    const into = vi.fn()
    HTMLElement.prototype.scrollIntoView = into
    const base = globalThis.fetch
    const payloads: Record<string, unknown> = { ret1: hybridJson, out1: searchJson }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const m = /^\/api\/v2\/results\/([^/]+)\/payload$/.exec(url)
        return m && m[1] in payloads ? new Response(JSON.stringify(payloads[m[1]]), { status: 200 }) : base(url, init)
      }),
    )
    setup({ results: { ...ANSWERED, retrieve: { id: "retrieve", status: "done", artifact_id: "ret1" } } })
    const invite = await screen.findByTestId("ask-invite")
    expect(within(screen.getByTestId("ask-answer")).getByTestId("ask-invite")).toBe(invite)
    expect(invite.textContent).toBe("Try another search or a reranker, and ask again.Change settings")
    expect(screen.queryByRole("button", { name: /^Reranker/ })).toBeNull()
    fireEvent.click(within(invite).getByRole("button", { name: "Change settings" }))
    expect(screen.getByRole("button", { name: /^Reranker/ })).toBeTruthy()
    expect(into).toHaveBeenCalled()
    expect(into.mock.contexts.at(-1)).toBe(screen.getByTestId("ask-settings"))
  })

  it("says nothing of the kind before an answer, or over an answer that is out of date", () => {
    setup({ results: INDEX_DONE })
    expect(screen.queryByTestId("ask-invite")).toBeNull()
    cleanup()
    setup({ results: ANSWERED, stale: new Set(["use_case"]) })
    expect(screen.queryByTestId("ask-invite")).toBeNull()
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it("a sample's question chip takes the panel back up to the question box", async () => {
    const to = vi.fn()
    HTMLElement.prototype.scrollTo = to as never
    setup({ results: ANSWERED })
    fireEvent.click(await screen.findByRole("button", { name: "Why overlap?" }))
    expect(to).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }))
  })
})

describe("waiting its turn on the busy demo", () => {
  it("the panel's status says the demo is busy, for an Ask or a build that waits", () => {
    setup({ busy: true, asking: true, queued: true })
    expect(screen.getByTestId("index-status").textContent).toBe("The demo is busy with other learners. Your run starts in a moment.")
    cleanup()
    setup({ results: {}, busy: true, buildingStep: { title: "Parse" }, queued: true })
    expect(screen.getByTestId("index-status").textContent).toBe("The demo is busy with other learners. Your run starts in a moment.")
  })
})

describe("an empty question", () => {
  const blank = (doc = UPLOAD) => {
    const g = sampleGraph(LIVE, doc)
    return { ...g, nodes: g.nodes.map((n) => (n.stage === "query" ? { ...n, config: { ...n.config, text: "" } } : n)) }
  }

  it("invites a question about the document, and Ask waits for one", async () => {
    setup({ graph: blank() })
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toContain("Index ready"))
    expect(question().placeholder).toBe("Ask something about report.pdf.")
    expect(askButton().disabled).toBe(true)
  })

  it("counts spaces alone as empty", async () => {
    const g = blank()
    setup({ graph: { ...g, nodes: g.nodes.map((n) => (n.stage === "query" ? { ...n, config: { ...n.config, text: "   " } } : n)) } })
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toContain("Index ready"))
    expect(askButton().disabled).toBe(true)
  })
})

describe("the Ask panel header", () => {
  it("leaves out the pages for a document without any", async () => {
    const graph = sampleGraph(LIVE, { sha: "ef".repeat(32), filename: "field-guide.docx" })
    const results: Record<string, NodeState> = { ...INDEX_DONE }
    for (const n of graph.nodes) if (n.stage === "parse" || n.stage === "clean") results[n.id] = { id: n.id, status: "done", artifact_id: "doc1" }
    setup({ graph, results })
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/v2/results/doc1/payload")).toBe(true))
    await act(async () => {})
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toBe("Index ready: field-guide.docx, 42 pieces"))
  })

  it("names how many documents an index over several holds, and leaves out the pages", async () => {
    setup({ graph: withDocuments(sampleGraph(LIVE, SAMPLE), [SAMPLE, UPLOAD]) })
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toBe("Index ready: 2 documents, 42 pieces"))
  })

  it("offers no Search in choice with one document", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toContain("Index ready"))
    expect(screen.queryByRole("group", { name: "Search in" })).toBeNull()
  })

  it("asks about all the documents, or one of them, with Search in", async () => {
    const graph = withDocuments(sampleGraph(LIVE, SAMPLE), [SAMPLE, UPLOAD])
    const onSearchIn = vi.fn()
    setup({ graph, onSearchIn })
    const group = screen.getByRole("group", { name: "Search in" })
    const all = within(group).getByRole("button", { name: "All 2 documents" })
    expect(all.getAttribute("aria-pressed")).toBe("true")
    expect(within(group).getByRole("button", { name: SAMPLE.filename }).getAttribute("aria-pressed")).toBe("false")
    // Colour is never the only cue: each file's pill names it, beside its dot.
    expect(within(group).getByRole("button", { name: UPLOAD.filename }).querySelector("[data-file-dot]")).toBeTruthy()
    expect(question().placeholder).toBe("Ask something about these 2 documents.")
    fireEvent.click(within(group).getByRole("button", { name: UPLOAD.filename }))
    expect(onSearchIn).toHaveBeenCalledWith(UPLOAD.sha)
    fireEvent.click(all)
    expect(onSearchIn).toHaveBeenLastCalledWith(null)
  })

  it("says which document it searches, and how many pieces that one has", async () => {
    const graph = withDocuments(sampleGraph(LIVE, SAMPLE), [SAMPLE, UPLOAD])
    const chunk = graph.nodes.find((n) => n.stage === "chunk")!
    const results: Record<string, NodeState> = {
      ...INDEX_DONE,
      [chunk.id]: {
        id: chunk.id,
        status: "done",
        artifact_id: "chA",
        documents: { [SAMPLE.filename]: { status: "done", artifact_id: "chA" }, report_pdf: { status: "done", artifact_id: "chB" } },
      },
    }
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      url === "/api/v2/results/chB/payload" ? new Response(JSON.stringify({ doc_id: UPLOAD.sha, source_text: "", chunks: [{}, {}, {}] }), { status: 200 }) : base(url, init),
    )
    setup({ graph, results, searchIn: UPLOAD.sha })
    expect(screen.getByRole("button", { name: UPLOAD.filename }).getAttribute("aria-pressed")).toBe("true")
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toBe("Searching report.pdf only, 3 pieces"))
    expect(question().placeholder).toBe("Ask something about report.pdf.")
  })

  it("says the index is ready, with the file, its pages and its pieces", async () => {
    setup()
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toBe("Index ready: chunking-primer.pdf, 3 pages, 42 pieces"))
    expect(askButton().disabled).toBe(false)
  })

  it("asks for the index first when Index has not run, and Ask is disabled (Review Focus 5)", () => {
    setup({ results: {} })
    expect(screen.getByTestId("index-status").textContent).toBe("Build the index first.")
    expect(askButton().disabled).toBe(true)
  })

  it("with no file, says where to start", () => {
    const g = sampleGraph(LIVE, SAMPLE)
    const noFile: PipelineGraph = { ...g, nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, config: {} } : n)) }
    setup({ graph: noFile, results: {} })
    expect(screen.getByTestId("index-status").textContent).toBe("Pick a document in the Document step, then build the index.")
  })

  it("without a usable document, Ask is disabled and the panel says it needs one", async () => {
    setup({ needsDocument: true })
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toContain("Index ready"))
    expect(askButton().disabled).toBe(true)
    expect(screen.getByText("Needs a document.")).toBeTruthy()
  })

  it("while a build runs, says which step it is on and for how long", () => {
    const startedAt = startedAgo(5)
    setup({ results: {}, busy: true, buildingStep: { title: "Parse", startedAt } })
    expect(screen.getByTestId("index-status").textContent).toBe("Building the index: Parse, 5 s")
  })

  it("before a build's first step starts, says Building the index", () => {
    setup({ results: {}, busy: true, buildingStep: {} })
    expect(screen.getByTestId("index-status").textContent).toBe("Building the index")
  })

  it("a stale Index result counts as not built", () => {
    setup({ stale: new Set(["index"]) })
    expect(screen.getByTestId("index-status").textContent).toBe("Build the index first.")
    expect(askButton().disabled).toBe(true)
  })
})

describe("the question box", () => {
  it("is bound to the query node's text, and Ask and Ctrl+Enter ask", () => {
    const p = setup()
    expect(question().value).toBe("Why do chunk boundaries matter?")
    fireEvent.change(question(), { target: { value: "What does overlap cost?" } })
    expect(p.onConfig).toHaveBeenCalledWith("query", expect.objectContaining({ text: "What does overlap cost?" }))
    fireEvent.click(askButton())
    expect(p.onAsk).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(question(), { key: "Enter", ctrlKey: true })
    expect(p.onAsk).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(question(), { key: "Enter" })
    expect(p.onAsk).toHaveBeenCalledTimes(2)
  })

  it("Ask reads Asking and is disabled while its own run is going", () => {
    setup({ busy: true, asking: true })
    const button = screen.getByRole("button", { name: "Asking" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull()
  })

  it("Ask stays Ask, disabled, while another run (the index build) is going", () => {
    setup({ busy: true, asking: false })
    const button = screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Asking" })).toBeNull()
  })

  it("says why the results are gone when the settings moved past them", () => {
    setup({ results: { ...INDEX_DONE, use_case: { id: "use_case", status: "done", artifact_id: "out1" } }, stale: new Set(["use_case"]) })
    expect(screen.getByTestId("stale-results").textContent).toBe("Settings changed. Ask again to see what changed.")
    // In the out-of-date tone, and the Ask button carries a soft ring until it is pressed.
    expect(screen.getByTestId("stale-results").className.split(/\s+/)).toContain("bg-stale-wash")
    expect(askButton().className.split(/\s+/)).toContain("ring-accent-wash")
  })

  it("says nothing about stale results when the results are fresh or there are none", () => {
    setup({ results: { ...INDEX_DONE, use_case: { id: "use_case", status: "done", artifact_id: "out1" } } })
    expect(screen.queryByTestId("stale-results")).toBeNull()
    cleanup()
    setup({ stale: new Set(["use_case"]) })
    expect(screen.queryByTestId("stale-results")).toBeNull()
  })

  it("shows a run error from Build as one line in the panel", () => {
    setup({ runError: "The run could not start. See the note above the cards." })
    expect(screen.getByRole("alert").textContent).toBe("The run could not start. See the note above the cards.")
  })

  it("shows the sample's questions as chips, and a chip sets the text", async () => {
    const p = setup()
    const chip = await screen.findByRole("button", { name: "Why overlap?" })
    expect(screen.getByText("Try one of the sample's questions:")).toBeTruthy()
    expect(screen.getByRole("button", { name: "What is a chunk?" })).toBeTruthy()
    fireEvent.click(chip)
    expect(p.onConfig).toHaveBeenCalledWith("query", expect.objectContaining({ text: "Why overlap?" }))
  })

  it("chips wrap: no chip keeps its text on one line or refuses to shrink", async () => {
    setup()
    const chip = await screen.findByRole("button", { name: "Why overlap?" })
    expect(chip.className.split(/\s+/)).not.toContain("whitespace-nowrap")
    expect(chip.className.split(/\s+/)).not.toContain("shrink-0")
    // A fixed height would let a wrapped second line spill over the chip below.
    expect(chip.className.split(/\s+/).filter((c) => /^h-/.test(c))).toEqual([])
  })

  it("Ask sits on the row under the question box, beside the shortcut hint", () => {
    setup()
    const row = askButton().parentElement!
    expect(within(row).getByText("Ctrl+Enter asks it.")).toBeTruthy()
    expect(row.className).toContain("justify-between")
    expect(row.lastElementChild).toBe(askButton())
  })

  it("shows no chips for an upload", async () => {
    setup({ graph: sampleGraph(LIVE, UPLOAD) })
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    await waitFor(() => expect(calls()).toContain("/api/samples"))
    // The list has answered and names no sample with this file, so no question set is asked for.
    await waitFor(() => expect(screen.getByTestId("index-status").textContent).toContain("report.pdf"))
    expect(calls().filter((u) => u.endsWith("/questions"))).toEqual([])
    expect(screen.queryByText("Try one of the sample's questions:")).toBeNull()
    expect(screen.queryByRole("button", { name: "Why overlap?" })).toBeNull()
  })

  it("shows a field error on the question", () => {
    setup({ errors: { query: { fields: { text: ["Text is required"] } } } })
    expect(screen.getByText("Text is required")).toBeTruthy()
  })

  it("renders the key notice under the Ask button, with the key hint (Review Focus 3)", () => {
    setup({ keyNotice: "Search results are ready. Add a key to get a written answer." })
    const notice = screen.getByTestId("key-notice")
    expect(notice.textContent!.startsWith("Search results are ready. Add a key to get a written answer.")).toBe(true)
    expect(within(notice).getByTestId("key-hint")).toBeTruthy()
  })
})

describe("the recipe line and the settings toggle", () => {
  it("reads the e2e sample graph as one line", () => {
    setup({ graph: e2eSampleGraph(LIVE, SAMPLE) })
    expect(screen.getByTestId("recipe").textContent).toBe("Hybrid (RRF), top 20 candidates. Rerank: MMR, keep 5. Answer: Search.")
  })

  it("says none without a reranker, and names the chat model", () => {
    const g = sampleGraph(LIVE, SAMPLE)
    const chat: PipelineGraph = { ...g, nodes: g.nodes.map((n) => (n.stage === "use_case" ? { ...n, transform: "chat", config: { model: "claude-opus-5" } } : n)) }
    setup({ graph: chat })
    expect(screen.getByTestId("recipe").textContent).toBe("Hybrid (RRF), top 20 candidates. Rerank: none. Answer: Chat with Claude Opus 5.")
  })

  it("names the rewrite after the retrieval part", () => {
    setup({ graph: setRewrite(sampleGraph(LIVE, SAMPLE), LIVE, "prf") })
    expect(screen.getByTestId("recipe").textContent).toBe("Hybrid (RRF), top 20 candidates, rewritten by PRF. Rerank: none. Answer: Search.")
    cleanup()
    setup({ graph: setRewrite(sampleGraph(LIVE, SAMPLE), LIVE, "llm") })
    expect(screen.getByTestId("recipe").textContent).toBe("Hybrid (RRF), top 20 candidates, rewritten by the model. Rerank: none. Answer: Search.")
  })

  it("the Rewrite control reaches onRewrite", () => {
    const p = setup()
    fireEvent.click(within(screen.getByRole("group", { name: "Rewrite" })).getByRole("button", { name: "PRF" }))
    expect(p.onRewrite).toHaveBeenCalledWith("prf")
  })

  it("settings are open on a fresh pipeline and fold when Ask is pressed", () => {
    setup({ results: { ...INDEX_DONE } })
    // Only the Index has a result: the Ask steps have not run, so the settings are open.
    expect(screen.getByRole("button", { name: "Hide settings" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /^Reranker/ })).toBeTruthy()
    fireEvent.click(askButton())
    expect(screen.getByRole("button", { name: "Change settings" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^Reranker/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Change settings" }))
    expect(screen.getByRole("button", { name: /^Reranker/ })).toBeTruthy()
  })

  it("settings start folded once the question has an answer", () => {
    setup({ results: { ...INDEX_DONE, use_case: { id: "use_case", status: "done", artifact_id: "out1" } } })
    expect(screen.getByRole("button", { name: "Change settings" })).toBeTruthy()
  })

  it("fetches the samples list once", async () => {
    setup()
    await screen.findByRole("button", { name: "Why overlap?" })
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    expect(calls.filter((u) => u === "/api/samples")).toHaveLength(1)
  })

  it("an error arriving after Ask unfolds the settings in place", () => {
    const p = setup()
    cleanup()
    const { rerender } = render(<AskPanel {...p} />)
    fireEvent.click(askButton())
    expect(screen.queryByRole("button", { name: /^Reranker/ })).toBeNull()
    rerender(<AskPanel {...p} errors={{ use_case: { message: "The search step could not run." } }} />)
    expect(screen.getByRole("button", { name: /^Reranker/ })).toBeTruthy()
    expect(screen.getByText("The search step could not run.")).toBeTruthy()
  })

  it("while a settings error shows, the toggle says why it cannot fold, and does not", () => {
    setup({ errors: { use_case: { message: "The search step could not run." } } })
    const toggle = screen.getByRole("button", { name: "Hide settings" }) as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute("aria-disabled")).toBe("true")
    expect(toggle.title).toBe("Fix the error below first.")
    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: /^Reranker/ })).toBeTruthy()
  })

  it("labels the recipe line", () => {
    setup()
    const recipe = screen.getByTestId("recipe")
    expect(recipe.previousElementSibling?.textContent).toBe("Recipe")
  })

  it("has no en or em dash anywhere", async () => {
    setup({ graph: e2eSampleGraph(LIVE, SAMPLE) })
    await screen.findByRole("button", { name: "Why overlap?" })
    expect(document.body.textContent).not.toMatch(new RegExp("[\\u2013\\u2014]"))
  })
})

describe("the Rerank block reflects the graph (Review Focus 1)", () => {
  const picked = () => screen.getByRole("button", { name: /^Reranker/ }).getAttribute("data-picked")

  it("a graph with a cross-encoder shows Cross-encoder", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder") })
    expect(picked()).toBe("cross_encoder")
    expect(screen.getByRole("button", { name: /^Reranker/ }).textContent).toContain("Cross-encoder")
  })

  it("a graph without a reranker shows None", () => {
    setup()
    expect(picked()).toBe("")
    expect(screen.getByRole("button", { name: /^Reranker/ }).textContent).toContain("No reranker")
  })
})

describe("Answer with, above the question", () => {
  const ANSWERED = { ...INDEX_DONE, use_case: { id: "use_case", status: "done" as const, artifact_id: "out1" } }
  const KEYED: Keys = { ...NO_KEYS, anthropic: "sk-test" }
  const CHAT = setUseCase(sampleGraph(LIVE, SAMPLE), LIVE, "chat")
  const mode = () => screen.getByRole("group", { name: "Answer with" })
  const segment = (name: string) => within(mode()).getByRole("button", { name }) as HTMLButtonElement
  const HINT = "You have a key. Switch to Chat with a model for a written answer with citations."

  it("sits above the question box, outside the settings", () => {
    setup({ keys: KEYED, results: ANSWERED })
    expect(screen.queryByTestId("ask-settings")).toBeNull()
    expect(segment("Search")).toBeTruthy()
    expect(Boolean(mode().compareDocumentPosition(question()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(segment("Search").getAttribute("aria-pressed")).toBe("true")
  })

  it("keeps the Ask button's label in Chat", () => {
    setup({ keys: KEYED, graph: CHAT })
    expect(askButton()).toBeTruthy()
  })

  it("switching calls onUseCase", () => {
    const p = setup({ keys: KEYED })
    fireEvent.click(segment("Chat with a model"))
    expect(p.onUseCase).toHaveBeenCalledWith("chat")
  })

  it("with no key anywhere, Chat is off with its reason, and Add a key opens the key panel", () => {
    setup({ server: { anthropic: "none", openai: "none", custom: "none", openrouter: "none" } as never })
    expect(segment("Chat with a model").disabled).toBe(true)
    expect(segment("Chat with a model").title).toBe("Add a key to turn Chat on")
    expect(screen.getByText("Chat needs an API key.")).toBeTruthy()
    expect(screen.getByTestId("key-panel").textContent).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: "Add a key" }))
    expect(screen.getByTestId("key-panel").textContent).toBe("true")
  })

  it("on Search with a key, says what Search does", () => {
    setup({ keys: KEYED })
    expect(screen.getByText("Shows the pieces that match. No model, no cost.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add a key" })).toBeNull()
  })

  it("on Chat, names the model and the provider's key, and Change model opens the settings", () => {
    setup({ keys: KEYED, graph: CHAT, results: ANSWERED })
    const line = screen.getByTestId("answer-mode-line")
    expect(line.textContent).toContain("claude-opus-5")
    expect(line.textContent).toContain("your Anthropic key")
    expect(screen.queryByTestId("ask-settings")).toBeNull()
    fireEvent.click(within(line).getByRole("button", { name: "Change model" }))
    expect(screen.getByTestId("ask-settings")).toBeTruthy()
  })

  it("on Chat with the custom endpoint, says your endpoint", () => {
    const custom = { ...CHAT, nodes: CHAT.nodes.map((n) => (n.stage === "use_case" ? { ...n, config: { ...n.config, model: "custom" } } : n)) }
    setup({ keys: KEYED, graph: custom })
    expect(screen.getByTestId("answer-mode-line").textContent).toContain("your endpoint")
  })

  it("with a key, on Search, over an answer, offers Chat in place of the generic invite; Use Chat switches", async () => {
    const p = setup({ keys: KEYED, results: ANSWERED })
    const hint = await screen.findByTestId("ask-invite")
    expect(hint.textContent).toContain(HINT)
    expect(screen.getAllByTestId("ask-invite")).toHaveLength(1)
    fireEvent.click(within(hint).getByRole("button", { name: "Use Chat" }))
    expect(p.onUseCase).toHaveBeenCalledWith("chat")
  })

  it("Dismiss brings the generic invite back and the hint stays gone", async () => {
    setup({ keys: KEYED, results: ANSWERED })
    fireEvent.click(within(await screen.findByTestId("ask-invite")).getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(HINT, { exact: false })).toBeNull()
    expect(screen.getByTestId("ask-invite").textContent).toContain("Try another search or a reranker")
  })

  it("shows no key hint without a key, on Chat, or before an answer", () => {
    setup({ results: ANSWERED })
    expect(screen.queryByText(HINT, { exact: false })).toBeNull()
    cleanup()
    setup({ keys: KEYED, results: ANSWERED, graph: CHAT })
    expect(screen.queryByText(HINT, { exact: false })).toBeNull()
    cleanup()
    setup({ keys: KEYED, results: INDEX_DONE })
    expect(screen.queryByText(HINT, { exact: false })).toBeNull()
  })
})
