import { describe, expect, it } from "vitest"

import type { GraphNode } from "@/api/types"

import {
  cardNamedIn,
  cardOfStep,
  columnOf,
  graphToConfig,
  knownSteps,
  sameConfig,
  stepOfCard,
  type WorkingPipeline,
} from "./config"
import { addCleaner, addReranker, initialGraph, removeNode, sampleGraph, setConfig, setReranker, setTransform, type PipelineGraph } from "./graph"
import { sameGraph } from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"

const DOC = { sha: "a".repeat(64), filename: "report.pdf" }

function converted(g: unknown): WorkingPipeline {
  const c = graphToConfig(g)
  if (!c.ok) throw new Error(c.problem)
  return c.pipeline
}

describe("graphToConfig", () => {
  it("turns the sample graph into the pipeline file's shape, with the document and question beside it", () => {
    const p = converted(sampleGraph(R, DOC, "What is chunking?"))
    expect(p.config).toEqual({
      index: {
        parse: { use: "pdfium", mode: "text" },
        clean: [{ use: "dedupe_blocks", similarity: 0.95 }],
        chunk: { use: "recursive_character", chunk_size: 400, chunk_overlap: 80 },
        embed: { use: "qwen3-embedding-0.6b", truncate_dim: null },
        store: { use: "lancedb" },
      },
      retrieve: { search: { use: "hybrid_rrf", top_k: 5 } },
      answer: { use: "search", max_snippet_chars: 400 },
    })
    expect(p.documents).toEqual([DOC])
    expect(p.question).toEqual({ text: "What is chunking?", gold_answers: [] })
  })

  it("keeps a reranker stack in order and a model rewrite as the rewrite step, without the question", () => {
    const g = addReranker(sampleGraph(R, DOC), R)
    const llm: PipelineGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.stage === "query" ? { ...n, transform: "llm_rewrite", config: { text: "q", gold_answers: ["gold"], style: "keywords" } } : n,
      ),
    }
    const p = converted(llm)
    expect(p.config.retrieve?.rewrite).toEqual({ use: "llm_rewrite", style: "keywords" })
    expect(p.config.retrieve?.rerank).toEqual([{ use: "mmr", lambda_mult: 0.5 }])
    expect(p.question).toEqual({ text: "q", gold_answers: ["gold"] })
  })

  it("reads an old single gold_answer", () => {
    const g = sampleGraph(R, DOC)
    const old = { ...g, nodes: g.nodes.map((n) => (n.stage === "query" ? { ...n, config: { text: "q", gold_answer: "the gold" } } : n)) }
    expect(converted(old).question.gold_answers).toEqual(["the gold"])
  })

  it("converts a graph saved before retrieval existed into an index-only config", () => {
    const g = initialGraph(R)
    const nodes = g.nodes.filter((n) => ["source", "parse", "chunk", "index"].includes(n.stage))
    const kept = { nodes, edges: g.edges.filter((e) => nodes.some((n) => n.id === e.dst) && nodes.some((n) => n.id === e.src)) }
    const p = converted(kept)
    expect(p.config.retrieve).toBeUndefined()
    expect(p.config.answer).toBeUndefined()
  })

  it.each([
    ["not a graph", () => null, "It is not a pipeline"],
    ["two parse steps", (g: PipelineGraph) => ({ ...g, nodes: [...g.nodes, { ...g.nodes.find((n) => n.stage === "parse")!, id: "parse_2" }] }), "2 Parse steps"],
    ["no chunk step", (g: PipelineGraph) => removeNode(g, "chunk"), "no Parse, Chunk or Index step"],
    ["a stage the column has no place for", (g: PipelineGraph) => ({ ...g, nodes: [...g.nodes, { id: "e", stage: "enrich", transform: "x", config: {} } as unknown as GraphNode] }), "enrich step"],
    ["a step not fed by the one above it", (g: PipelineGraph) => ({ ...g, edges: g.edges.filter((e) => e.dst !== "chunk") }), "Chunk step is not fed"],
    ["another source than uploads", (g: PipelineGraph) => ({ ...g, nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, transform: "web" } : n)) }), "uploaded files only"],
    ["a null connection", (g: PipelineGraph) => ({ ...g, edges: [...g.edges, null] }), "one of its connections is broken"],
    ["a connection without a source", (g: PipelineGraph) => ({ ...g, edges: [...g.edges, { dst: "chunk", port: "doc" }] }), "one of its connections is broken"],
    ["settings that are not a mapping", (g: PipelineGraph) => ({ ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, config: "big" } : n)) }), "one of its steps has broken settings"],
    [
      "a rewrite without a search step",
      (g: PipelineGraph) => {
        const asked = g.nodes.filter((n) => !["retrieve", "use_case"].includes(n.stage)).map((n) => (n.stage === "query" ? { ...n, transform: "llm_rewrite" } : n))
        return { nodes: asked, edges: g.edges.filter((e) => asked.some((n) => n.id === e.src) && asked.some((n) => n.id === e.dst)) }
      },
      "without a search step",
    ],
  ])("refuses %s and says why", (_, change, words) => {
    const c = graphToConfig(change(sampleGraph(R, DOC)))
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.problem).toContain(words)
  })
})

describe("columnOf", () => {
  it("draws the same column the sample graph is", () => {
    const g = sampleGraph(R, DOC, "What is chunking?")
    expect(sameGraph(columnOf(converted(g), R), g)).toBe(true)
  })

  it.each([
    ["a cleaner added", (g: PipelineGraph) => addCleaner(g, R)],
    ["a reranker added", (g: PipelineGraph) => addReranker(g, R)],
    ["the reranker removed", (g: PipelineGraph) => setReranker(addReranker(g, R), R, null)],
    ["another chunker", (g: PipelineGraph) => setTransform(g, "chunk", "token_based", R)],
    ["a setting changed", (g: PipelineGraph) => setConfig(g, "chunk", { chunk_size: 900, chunk_overlap: 0 })],
  ])("round-trips the column after %s", (_, edit) => {
    const g = edit(sampleGraph(R, DOC))
    expect(sameGraph(columnOf(converted(g), R), g)).toBe(true)
  })

  it("gives an index-only config the default ask cards", () => {
    const p = converted(sampleGraph(R, DOC))
    const indexOnly: WorkingPipeline = { ...p, config: { index: p.config.index } }
    expect(columnOf(indexOnly, R).nodes.map((n) => n.stage)).toEqual(expect.arrayContaining(["query", "retrieve", "use_case"]))
  })
})

describe("card ids and step names", () => {
  it.each([
    ["parse", "parse"], ["clean.2", "clean_2"], ["chunk", "chunk"], ["index", "index"],
    ["rewrite", "query"], ["search", "retrieve"], ["rerank.1", "rerank_1"], ["answer", "use_case"], ["source", "source"],
  ])("step %s is card %s, both ways", (step, card) => {
    expect(cardOfStep(step)).toBe(card)
    expect(stepOfCard(card)).toBe(step)
  })

  it.each([
    ["index.chunk: chunk_overlap must be smaller than chunk_size.", "chunk"],
    ["index.clean.2 uses 'nope', which is not registered.", "clean_2"],
    ["retrieve.search: top_k must be at least 1.", "retrieve"],
    ["index.embed: unknown embedder", "index"],
    ["answer uses 'x'", "use_case"],
    ["The pipeline must be a mapping.", null],
    ["Settings: answer: max_snippet_chars must be at least 1.", "use_case"],
    ["A search step is needed to answer the question.", null],
    ["It needs an answer step.", null],
    // Pandion's own wording (pandion/config.py) names a stacked step as "step N".
    ["index.clean step 2 uses 'nope', which is not registered.", "clean_2"],
    ["retrieve.rerank step 3: top_n must be at least 1.", "rerank_3"],
  ])("finds the card in %s", (sentence, card) => {
    expect(cardNamedIn(sentence)).toBe(card)
  })
})

describe("knownSteps and sameConfig", () => {
  it("says whether every step exists on this server", () => {
    const p = converted(sampleGraph(R, DOC))
    expect(knownSteps(p.config, R)).toBe(true)
    expect(knownSteps({ ...p.config, index: { ...p.config.index, parse: { use: "elsewhere" } } }, R)).toBe(false)
  })

  it("ignores key order", () => {
    expect(
      sameConfig(
        { index: { parse: { use: "pdfium" }, chunk: { use: "c", a: 1, b: 2 }, store: { use: "s" } } },
        { index: { store: { use: "s" }, chunk: { b: 2, a: 1, use: "c" }, parse: { use: "pdfium" } } },
      ),
    ).toBe(true)
  })
})
