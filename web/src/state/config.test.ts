import { describe, expect, it } from "vitest"

import type { GraphNode } from "@/api/types"

import {
  cardNamedIn,
  cardOfStep,
  cardOfStepIn,
  columnOf,
  graphToConfig,
  isConfigShape,
  knownSteps,
  sameConfig,
  unknownStrategy,
  stepOfCard,
  stepOfCardIn,
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
    ["a stage the column has no place for", (g: PipelineGraph) => ({ ...g, nodes: [...g.nodes, { id: "e", stage: "enrich", transform: "x", config: {} } as unknown as GraphNode] }), "It has an enrich step"],
    ["a stage the column has no place for, named with a consonant", (g: PipelineGraph) => ({ ...g, nodes: [...g.nodes, { id: "s", stage: "summary", transform: "x", config: {} } as unknown as GraphNode] }), "It has a summary step"],
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

describe("stacked cards by their place in the column", () => {
  // Two cleaners, the first removed, then one added: a lone clean_2, then [clean_2, clean_1].
  const two = addCleaner(addCleaner(initialGraph(R), R), R)
  const gap = removeNode(two, "clean_1")
  const swapped = addCleaner(gap, R)
  const rr = addReranker(removeNode(addReranker(addReranker(initialGraph(R), R), R), "rerank_1"), R)

  it("the ids are what a user who removed and added a cleaner gets", () => {
    expect(gap.nodes.filter((n) => n.stage === "clean").map((n) => n.id)).toEqual(["clean_2"])
    expect(swapped.nodes.filter((n) => n.stage === "clean").map((n) => n.id)).toEqual(["clean_2", "clean_1"])
  })

  it("the Nth Clean or Rerank card is step N, whatever its id", () => {
    expect(stepOfCardIn(gap, "clean_2")).toBe("clean.1")
    expect(stepOfCardIn(swapped, "clean_2")).toBe("clean.1")
    expect(stepOfCardIn(swapped, "clean_1")).toBe("clean.2")
    expect(stepOfCardIn(rr, "rerank_2")).toBe("rerank.1")
    expect(stepOfCardIn(rr, "rerank_1")).toBe("rerank.2")
    expect(stepOfCardIn(swapped, "chunk")).toBe("chunk")
    expect(stepOfCardIn(swapped, "retrieve")).toBe("search")
  })

  it("step N is the Nth card, and a step the column lacks is no card", () => {
    expect(cardOfStepIn(gap, "clean.1")).toBe("clean_2")
    expect(cardOfStepIn(gap, "clean.2")).toBeNull()
    expect(cardOfStepIn(swapped, "clean.1")).toBe("clean_2")
    expect(cardOfStepIn(swapped, "clean.2")).toBe("clean_1")
    expect(cardOfStepIn(rr, "rerank.2")).toBe("rerank_1")
    expect(cardOfStepIn(swapped, "search")).toBe("retrieve")
  })

  it("a problem sentence names the card at that place", () => {
    expect(cardNamedIn("index.clean step 2 uses 'nope', which is not registered.", swapped)).toBe("clean_1")
    expect(cardNamedIn("index.clean.1: bad", swapped)).toBe("clean_2")
    expect(cardNamedIn("index.clean step 2: bad", gap)).toBeNull()
    expect(cardNamedIn("index.chunk: bad", swapped)).toBe("chunk")
    expect(cardNamedIn("index.store: bad", swapped)).toBe("index")
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

describe("the shape of a config from outside", () => {
  const good = () => {
    const c = graphToConfig(sampleGraph(R, { sha: "e".repeat(64), filename: "x.pdf" }))
    if (!c.ok) throw new Error(c.problem)
    return c.pipeline.config as unknown as Record<string, any>
  }

  it("accepts a config the converter makes", () => {
    expect(isConfigShape(good())).toBe(true)
  })

  it.each([
    ["clean is a string", (c: Record<string, any>) => ({ ...c, index: { ...c.index, clean: "a" } })],
    ["clean holds a number", (c: Record<string, any>) => ({ ...c, index: { ...c.index, clean: [5] } })],
    ["parse is a string", (c: Record<string, any>) => ({ ...c, index: { ...c.index, parse: "x" } })],
    ["a step's use is not a string", (c: Record<string, any>) => ({ ...c, index: { ...c.index, chunk: { use: 5 } } })],
    ["rerank is a record", (c: Record<string, any>) => ({ ...c, retrieve: { ...c.retrieve, rerank: { use: "mmr" } } })],
    ["retrieve has no search", (c: Record<string, any>) => ({ ...c, retrieve: {} })],
    ["answer is a string", (c: Record<string, any>) => ({ ...c, answer: "chat" })],
    ["it names plugins", (c: Record<string, any>) => ({ ...c, plugins: ["x"] })],
  ])("refuses a config where %s", (_why, bend) => {
    expect(isConfigShape(bend(good()))).toBe(false)
  })

  it("counts a step whose use is not a string as unknown", () => {
    const c = good()
    expect(unknownStrategy({ ...c, index: { ...c.index, chunk: { use: 5 } } } as never, R)).not.toBeNull()
  })

  it("keeps a long made-up step name short in its problem sentence", () => {
    const r = graphToConfig({ nodes: [{ id: "x", stage: "z".repeat(500), transform: "y", config: {} }], edges: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.length).toBeLessThan(140)
  })
})
