import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { askNodes, initialGraph, sampleGraph, setReranker, setTransform, setUseCase } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { AskSettings, type AskSettingsProps } from "./AskSettings"

const LIVE = liveRegistry as unknown as Registry
const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup(over: Partial<AskSettingsProps> = {}) {
  const props: AskSettingsProps = {
    graph: sampleGraph(LIVE, SAMPLE),
    registry: LIVE,
    hasKey: null,
    errors: {},
    onConfig: vi.fn(),
    onTransform: vi.fn(),
    onReranker: vi.fn(),
    onUseCase: vi.fn(),
    ...over,
  }
  render(<AskSettings {...props} />)
  return props
}

const block = (name: string) => within(screen.getByRole("region", { name }))
const segment = (group: string, name: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name }) as HTMLButtonElement

describe("the Retrieval block", () => {
  it("offers the strategies by their technical names, with a gloss and the stage name", () => {
    setup()
    const b = block("Retrieval")
    const select = b.getByLabelText("Strategy") as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent).sort()).toEqual(["BM25", "Dense", "Hybrid (RRF)"])
    expect(select.value).toBe("hybrid_rrf")
    expect(b.getByText("Meaning search and keyword search, fused by reciprocal rank.")).toBeTruthy()
    expect(b.getByText("retrieve")).toBeTruthy()
  })

  it("picking a strategy calls onTransform on the retrieve node", () => {
    const p = setup()
    fireEvent.change(block("Retrieval").getByLabelText("Strategy"), { target: { value: "bm25" } })
    expect(p.onTransform).toHaveBeenCalledWith("retrieve", "bm25")
  })

  it("its settings are the retrieve node's schema form", () => {
    const p = setup()
    const topK = block("Retrieval").getByLabelText("Candidates, top k") as HTMLInputElement
    expect(topK.value).toBe("20")
    fireEvent.change(topK, { target: { value: "8" } })
    expect(p.onConfig).toHaveBeenCalledWith("retrieve", expect.objectContaining({ top_k: 8 }))
  })

  it("a soft lock is tagged and still selectable", () => {
    const dense = R.retrieve!.dense
    const soft: Registry = {
      ...R,
      retrieve: { ...R.retrieve, dense: { ...dense, prefers: { index: { backends: ["dense"] } }, fallback: "It searches by keyword instead." } },
    }
    setup({ graph: initialGraph(soft), registry: soft })
    const option = block("Retrieval").getByRole("option", { name: "Dense · falls back" }) as HTMLOptionElement
    expect(option.disabled).toBe(false)
  })

  it("a hard lock is disabled in the select, and the reason shows when it is picked", () => {
    setup({ graph: setTransform(initialGraph(R), "retrieve", "bm25", R), registry: R })
    const b = block("Retrieval")
    const option = b.getByRole("option", { name: "BM25 · locked" }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
    expect(b.getByTestId("lock-reason").getAttribute("role")).toBe("alert")
    expect(b.getByRole("alert").textContent).toBe("Needs text search from the index step. lancedb does not provide it, so this cannot run.")
  })
})

describe("the Rerank block", () => {
  it("None removes the reranker and Cross-encoder adds one", () => {
    const p = setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "mmr") })
    fireEvent.click(segment("Reranker", "None"))
    expect(p.onReranker).toHaveBeenCalledWith(null)
    fireEvent.click(segment("Reranker", "Cross-encoder"))
    expect(p.onReranker).toHaveBeenCalledWith("cross_encoder")
  })

  it("shows the chosen reranker's summary and its schema form", () => {
    const g = setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder")
    const p = setup({ graph: g })
    const b = block("Rerank")
    expect(b.getByText(LIVE.rerank!.cross_encoder.summary!)).toBeTruthy()
    expect(b.getByText("rerank")).toBeTruthy()
    const id = askNodes(g).rerank!.id
    fireEvent.change(b.getByLabelText("Keep, top k"), { target: { value: "3" } })
    expect(p.onConfig).toHaveBeenCalledWith(id, expect.objectContaining({ top_k: 3 }))
  })

  it("LLM is disabled without a key, with the reason", () => {
    setup({ hasKey: false })
    expect(segment("Reranker", "LLM").disabled).toBe(true)
    expect(screen.getByText("Add a key to use the LLM reranker")).toBeTruthy()
  })

  it("LLM is enabled with a key, and while keys are unknown", () => {
    setup({ hasKey: true })
    expect(segment("Reranker", "LLM").disabled).toBe(false)
    cleanup()
    setup({ hasKey: null })
    expect(segment("Reranker", "LLM").disabled).toBe(false)
    expect(screen.queryByText("Add a key to use the LLM reranker")).toBeNull()
  })
})

describe("the Answer block", () => {
  it("switches between Search and Chat", () => {
    const p = setup()
    expect(segment("Answer with", "Search").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(segment("Answer with", "Chat with a model"))
    expect(p.onUseCase).toHaveBeenCalledWith("chat")
    expect(block("Answer").getByText("use_case")).toBeTruthy()
  })

  it("Chat is disabled without a key, with the reason", () => {
    setup({ hasKey: false })
    expect(segment("Answer with", "Chat with a model").disabled).toBe(true)
    expect(screen.getByText("Add a key to turn Chat on")).toBeTruthy()
  })

  it("with Chat, the chat model select appears", () => {
    setup({ graph: setUseCase(sampleGraph(LIVE, SAMPLE), LIVE, "chat") })
    expect(block("Answer").getByLabelText("Model")).toBeTruthy()
  })

  it("says what Search and Chat give", () => {
    setup()
    expect(block("Answer").getByText("Search shows the kept pieces. Chat writes an answer with citations.")).toBeTruthy()
  })
})

/** The block's closed More disclosure, or null. */
const more = (name: string) => screen.getByRole("region", { name }).querySelector("details") as HTMLDetailsElement | null
const inMore = (name: string, label: string) => more(name)!.contains(block(name).getByLabelText(label))

describe("primary fields and the More disclosure", () => {
  it("Retrieval shows Strategy and Candidates, with RRF k under a closed More", () => {
    setup()
    expect(more("Retrieval")!.open).toBe(false)
    expect(more("Retrieval")!.querySelector("summary")!.textContent).toBe("More")
    expect(inMore("Retrieval", "Candidates, top k")).toBe(false)
    expect(inMore("Retrieval", "RRF k")).toBe(true)
  })

  it("Answer with Search puts its top k and snippet length under More, in sentence case", () => {
    const p = setup()
    expect(inMore("Answer", "Show, top k")).toBe(true)
    expect(inMore("Answer", "Snippet length")).toBe(true)
    // A field under More still edits the whole config.
    fireEvent.change(block("Answer").getByLabelText("Snippet length"), { target: { value: "200" } })
    expect(p.onConfig).toHaveBeenCalledWith("use_case", expect.objectContaining({ max_snippet_chars: 200, top_k: 5 }))
  })

  it("Answer with Chat keeps the model in front and the rest under More", () => {
    setup({ graph: setUseCase(sampleGraph(LIVE, SAMPLE), LIVE, "chat") })
    expect(inMore("Answer", "Model")).toBe(false)
    expect(inMore("Answer", "Citation Method")).toBe(true)
  })

  it("Rerank keeps the model and Keep, top k in front; MMR's lambda goes under More", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder") })
    expect(block("Rerank").getByLabelText("Model")).toBeTruthy()
    expect(more("Rerank")).toBeNull()
    cleanup()
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "mmr") })
    expect(inMore("Rerank", "Keep, top k")).toBe(false)
    expect(inMore("Rerank", "Lambda Mult")).toBe(true)
  })

  it("a server error on a field under More opens it", () => {
    setup({ errors: { retrieve: { fields: { rrf_k: ["Input should be greater than 0"] } } } })
    expect(more("Retrieval")!.open).toBe(true)
  })

  it("the Cross-encoder model select carries its full value as a title", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder") })
    const select = block("Rerank").getByLabelText("Model") as HTMLSelectElement
    expect(select.title).toBe(select.value)
    expect(select.className).toContain("w-full")
    expect(select.className).toContain("min-w-0")
  })
})

describe("the pressed segment", () => {
  it("takes the accent border and text of the primary button; the others do not", () => {
    setup()
    expect(segment("Reranker", "None").className).toContain("border-primary")
    expect(segment("Reranker", "None").className).toContain("text-primary")
    expect(segment("Reranker", "MMR").className).not.toContain("border-primary")
    expect(segment("Answer with", "Search").className).toContain("border-primary")
  })

  it("is the shared segmented control: the accent wash fill on the pressed option only", () => {
    setup()
    expect(segment("Reranker", "None").className).toContain("bg-accent-wash")
    expect(segment("Reranker", "MMR").className).not.toContain("bg-accent-wash")
    expect(segment("Answer with", "Search").className).toContain("bg-accent-wash")
  })

  it("a disabled LLM or Chat carries its reason as a title", () => {
    setup({ hasKey: false })
    expect(segment("Reranker", "LLM").title).toBe("Add a key to use the LLM reranker")
    expect(segment("Answer with", "Chat with a model").title).toBe("Add a key to turn Chat on")
  })
})
