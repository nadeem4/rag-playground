import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry } from "@/api/types"
import { e2eSampleGraph, sampleGraph, setReranker, type PipelineGraph } from "@/state/graph"

import { AskPanel, type AskPanelProps } from "./AskPanel"

const LIVE = liveRegistry as unknown as Registry
const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null }
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
      if (url === "/api/artifacts/idx1/payload") return ok({ doc_count: 42 })
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
    askRunId: null,
    transcript: [],
    comparisonHidden: null,
    onComparison: vi.fn(),
    onLog: vi.fn(),
    onConfig: vi.fn(),
    onTransform: vi.fn(),
    onReranker: vi.fn(),
    onUseCase: vi.fn(),
    onAsk: vi.fn(),
    ...over,
  }
  render(<AskPanel {...props} />)
  return props
}

const askButton = () => screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement
const question = () => screen.getByLabelText("Question") as HTMLTextAreaElement

describe("the Ask panel header", () => {
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
    expect(screen.getByTestId("index-status").textContent).toBe("Load a PDF or pick a sample on the Upload card, then build the index.")
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

  it("Ask is disabled while a run is going", () => {
    setup({ busy: true })
    expect(askButton().disabled).toBe(true)
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

  it("settings are open on a fresh pipeline and fold when Ask is pressed", () => {
    setup({ results: { ...INDEX_DONE } })
    // Only the Index has a result: the Ask steps have not run, so the settings are open.
    expect(screen.getByRole("button", { name: "Hide settings" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Reranker" })).toBeTruthy()
    fireEvent.click(askButton())
    expect(screen.getByRole("button", { name: "Change settings" })).toBeTruthy()
    expect(screen.queryByRole("group", { name: "Reranker" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Change settings" }))
    expect(screen.getByRole("group", { name: "Reranker" })).toBeTruthy()
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
    expect(screen.queryByRole("group", { name: "Reranker" })).toBeNull()
    rerender(<AskPanel {...p} errors={{ use_case: { message: "The search step could not run." } }} />)
    expect(screen.getByRole("group", { name: "Reranker" })).toBeTruthy()
    expect(screen.getByText("The search step could not run.")).toBeTruthy()
  })

  it("while a settings error shows, the toggle says why it cannot fold, and does not", () => {
    setup({ errors: { use_case: { message: "The search step could not run." } } })
    const toggle = screen.getByRole("button", { name: "Hide settings" }) as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute("aria-disabled")).toBe("true")
    expect(toggle.title).toBe("Fix the error below first.")
    fireEvent.click(toggle)
    expect(screen.getByRole("group", { name: "Reranker" })).toBeTruthy()
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
  const pressed = (name: string) => within(screen.getByRole("group", { name: "Reranker" })).getByRole("button", { name }).getAttribute("aria-pressed")

  it("a graph with a cross-encoder shows Cross-encoder", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder") })
    expect(pressed("Cross-encoder")).toBe("true")
    expect(pressed("None")).toBe("false")
  })

  it("a graph without a reranker shows None", () => {
    setup()
    expect(pressed("None")).toBe("true")
    expect(pressed("MMR")).toBe("false")
  })
})
