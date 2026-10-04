import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { choose, optionNames, optionOf } from "@/components/ui/pickerTesting"
import { askNodes, initialGraph, sampleGraph, setReranker, setRewrite, setTransform, setUseCase } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { AskSettings, LLM_GLOSS, PRF_GLOSS, type AskSettingsProps } from "./AskSettings"

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
    onRewrite: vi.fn(),
    ...over,
  }
  render(<AskSettings {...props} />)
  return props
}

const block = (name: string) => within(screen.getByRole("region", { name }))
const reranker = () => block("Rerank").getByRole("button", { name: /^Reranker/ })
const segment = (group: string, name: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name }) as HTMLButtonElement

describe("the Retrieval block", () => {
  it("offers Compare searches, which opens Compare on the retrieve node", () => {
    const p = setup({ onSweep: vi.fn() })
    fireEvent.click(block("Retrieval").getByRole("button", { name: "Compare searches" }))
    expect(p.onSweep).toHaveBeenCalledWith(askNodes(p.graph).retrieve!.id)
  })

  it("has no Compare searches button when the page cannot open Compare", () => {
    setup()
    expect(block("Retrieval").queryByRole("button", { name: "Compare searches" })).toBeNull()
  })

  it("offers the strategies by their technical names, with a gloss and the stage name", () => {
    setup()
    const b = block("Retrieval")
    const picker = b.getByRole("button", { name: /^Strategy/ })
    expect(picker.textContent).toContain("Hybrid (RRF)")
    expect(picker.textContent).toContain("hybrid_rrf")
    expect(optionNames(picker).sort()).toEqual(["BM25", "Dense", "Hybrid (RRF)"])
    expect(b.getByText("Meaning search and keyword search, fused by reciprocal rank.")).toBeTruthy()
    expect(b.getByText("retrieve")).toBeTruthy()
  })

  it("picking a strategy calls onTransform on the retrieve node", () => {
    const p = setup()
    choose(block("Retrieval").getByRole("button", { name: /^Strategy/ }), "BM25")
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
    const option = optionOf(block("Retrieval").getByRole("button", { name: /^Strategy/ }), "Dense")
    expect(option.textContent).toContain("Falls back")
    expect(option.getAttribute("aria-disabled")).toBe("false")
  })

  it("a hard lock is disabled in the picker, and the reason shows when it is picked", () => {
    setup({ graph: setTransform(initialGraph(R), "retrieve", "bm25", R), registry: R })
    const b = block("Retrieval")
    expect(b.getByTestId("lock-reason").getAttribute("role")).toBe("alert")
    expect(b.getByRole("alert").textContent).toBe("Needs text search from the index step. lancedb does not provide it, so this cannot run.")
    const option = optionOf(b.getByRole("button", { name: /^Strategy/ }), "BM25")
    expect(option.textContent).toContain("Cannot run")
    expect(option.getAttribute("aria-disabled")).toBe("true")
  })

  it("each strategy says what it does in one line, from its own summary", () => {
    setup()
    const option = optionOf(block("Retrieval").getByRole("button", { name: /^Strategy/ }), "BM25")
    expect(option.textContent).toContain("Scores pieces by the words they share with the question, counting rare words for more than common ones (the BM25 formula).")
    expect(option.textContent).not.toContain("It finds exact names")
  })
})

describe("the Rewrite control", () => {
  const QUESTION = "Who is my current employer?"
  const base = () => sampleGraph(LIVE, SAMPLE, QUESTION)

  it("sits in the Retrieval block with None, PRF and LLM, None chosen on an old graph", () => {
    setup()
    const group = block("Retrieval").getByRole("group", { name: "Rewrite" })
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["None", "PRF", "LLM"])
    expect(segment("Rewrite", "None").getAttribute("aria-pressed")).toBe("true")
  })

  it("each choice calls onRewrite with its mode", () => {
    const p = setup()
    fireEvent.click(segment("Rewrite", "PRF"))
    expect(p.onRewrite).toHaveBeenCalledWith("prf")
    fireEvent.click(segment("Rewrite", "LLM"))
    expect(p.onRewrite).toHaveBeenCalledWith("llm")
    cleanup()
    const q = setup({ graph: setRewrite(base(), LIVE, "prf") })
    fireEvent.click(segment("Rewrite", "None"))
    expect(q.onRewrite).toHaveBeenCalledWith("none")
  })

  it("PRF shows its gloss and its two fields, and they are absent otherwise", () => {
    setup()
    expect(block("Retrieval").queryByLabelText("Pieces to borrow from")).toBeNull()
    expect(block("Retrieval").queryByLabelText("Terms to add")).toBeNull()
    expect(block("Retrieval").queryByText("Query Expansion")).toBeNull()
    cleanup()
    const g = setRewrite(base(), LIVE, "prf")
    const p = setup({ graph: g })
    const b = block("Retrieval")
    expect(segment("Rewrite", "PRF").getAttribute("aria-pressed")).toBe("true")
    expect(b.getByText(PRF_GLOSS)).toBeTruthy()
    expect((b.getByLabelText("Pieces to borrow from") as HTMLInputElement).value).toBe("2")
    fireEvent.change(b.getByLabelText("Terms to add"), { target: { value: "4" } })
    expect(p.onConfig).toHaveBeenCalledWith("retrieve", expect.objectContaining({ prf_terms: 4, query_expansion: "prf" }))
  })

  it("LLM shows its gloss and the query node's model and style, not its question", () => {
    const g = setRewrite(base(), LIVE, "llm")
    const p = setup({ graph: g, hasKey: true })
    const b = block("Retrieval")
    expect(segment("Rewrite", "LLM").getAttribute("aria-pressed")).toBe("true")
    expect(b.getByText(LLM_GLOSS)).toBeTruthy()
    expect(b.queryByLabelText("Pieces to borrow from")).toBeNull()
    const style = b.getByLabelText("Style") as HTMLSelectElement
    expect(style.value).toBe("document words")
    expect(b.getByLabelText("Model")).toBeTruthy()
    expect(b.queryByDisplayValue(QUESTION)).toBeNull()
    fireEvent.change(style, { target: { value: "keywords" } })
    expect(p.onConfig).toHaveBeenCalledWith(askNodes(g).query!.id, expect.objectContaining({ style: "keywords", text: QUESTION }))
  })

  it("LLM is disabled with the reason only when there is surely no key", () => {
    setup({ hasKey: false })
    expect(segment("Rewrite", "LLM").disabled).toBe(true)
    expect(segment("Rewrite", "LLM").title).toBe("Add a key to rewrite with a model")
    expect(screen.getByText("Add a key to rewrite with a model")).toBeTruthy()
    cleanup()
    setup({ hasKey: null })
    expect(segment("Rewrite", "LLM").disabled).toBe(false)
    expect(screen.queryByText("Add a key to rewrite with a model")).toBeNull()
  })

  it("is absent when the registry has neither rewrite", () => {
    setup({ graph: initialGraph(R), registry: R })
    expect(screen.queryByRole("group", { name: "Rewrite" })).toBeNull()
  })
})

describe("the Rerank block", () => {
  it("No reranker removes the reranker and Cross-encoder adds one", () => {
    const p = setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "mmr") })
    choose(reranker(), "No reranker")
    expect(p.onReranker).toHaveBeenCalledWith(null)
    choose(reranker(), "Cross-encoder")
    expect(p.onReranker).toHaveBeenCalledWith("cross_encoder")
  })

  it("is a picker: each reranker by its name, code name and the first sentence of its summary", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "cross_encoder") })
    expect(reranker().textContent).toContain("Cross-encoder")
    expect(reranker().textContent).toContain("cross_encoder")
    expect(optionNames(reranker())).toEqual(["No reranker", "Cross-encoder", "MMR", "LLM"])
    const mmr = optionOf(reranker(), "MMR")
    expect(mmr.textContent).toContain("mmr")
    expect(mmr.textContent).toContain("Maximal Marginal Relevance picks results one at a time, each time taking the piece the retriever scored highest while being least like the pieces already picked.")
    expect(mmr.textContent).not.toContain("It trades relevance for variety")
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

  it("LLM is tagged Needs a key without a key, with the reason", () => {
    setup({ hasKey: false })
    expect(screen.getByText("Add a key to use the LLM reranker")).toBeTruthy()
    expect(optionOf(reranker(), "LLM").textContent).toContain("Needs a key")
  })

  it("a picked LLM reranker with no key says so under the picker", () => {
    setup({ graph: setReranker(sampleGraph(LIVE, SAMPLE), LIVE, "llm_rerank"), hasKey: false })
    expect(block("Rerank").getByTestId("key-note").textContent).toBe("Needs an API key. Add one under Key.")
  })

  it("LLM is not tagged with a key, nor while keys are unknown", () => {
    setup({ hasKey: true })
    expect(optionOf(reranker(), "LLM").textContent).not.toContain("Needs a key")
    cleanup()
    setup({ hasKey: null })
    expect(optionOf(reranker(), "LLM").textContent).not.toContain("Needs a key")
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
    expect(segment("Answer with", "Search").className).toContain("border-primary")
    expect(segment("Answer with", "Search").className).toContain("text-primary")
    expect(segment("Rewrite", "PRF").className).not.toContain("border-primary")
  })

  it("is the shared segmented control: the accent wash fill on the pressed option only", () => {
    setup()
    expect(segment("Answer with", "Search").className).toContain("bg-accent-wash")
    expect(segment("Rewrite", "PRF").className).not.toContain("bg-accent-wash")
  })

  it("a disabled Chat carries its reason as a title; the LLM reranker is tagged in its picker instead", () => {
    setup({ hasKey: false })
    expect(segment("Answer with", "Chat with a model").title).toBe("Add a key to turn Chat on")
    expect(optionOf(reranker(), "LLM").textContent).toContain("Needs a key")
  })
})
