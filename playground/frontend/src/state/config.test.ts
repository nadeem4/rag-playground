import { describe, expect, it } from "vitest"

import type { GraphNode } from "@/api/types"

import {
  cardOfProblem,
  cardOfStep,
  cardOfStepIn,
  categoriesOf,
  columnOf,
  graphToConfig,
  isConfigShape,
  knownSteps,
  removedText,
  sameConfig,
  servedConfig,
  unknownStrategy,
  withCategory,
  stepOfCard,
  stepOfCardIn,
  type PipelineConfig,
  type WorkingPipeline,
} from "./config"
import { addCleaner, addEnrich, addReranker, initialGraph, removeNode, sampleGraph, setConfig, setReranker, setTransform, type PipelineGraph } from "./graph"
import { documentsOf, withDocuments } from "./document"
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

  it("leaves a query card's filters out of the rewrite step", () => {
    const g = sampleGraph(R, DOC)
    const llm = {
      ...g,
      nodes: g.nodes.map((n) => (n.stage === "query" ? { ...n, transform: "llm_rewrite", config: { text: "q", gold_answers: [], filters: null, style: "keywords" } } : n)),
    }
    expect(converted(llm).config.retrieve?.rewrite).toEqual({ use: "llm_rewrite", style: "keywords" })
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
    ["a stage the column has no place for", (g: PipelineGraph) => ({ ...g, nodes: [...g.nodes, { id: "e", stage: "extract", transform: "x", config: {} } as unknown as GraphNode] }), "It has an extract step"],
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

describe("an Enrich step in the pipeline file", () => {
  it("writes it as index.enrich, between chunk and embed, and draws it back", () => {
    const g = setConfig(addEnrich(sampleGraph(R, DOC), R), "enrich", { model: "gpt-5.6-luna", max_pieces: 50 })
    const p = converted(g)
    expect(Object.keys(p.config.index)).toEqual(["parse", "clean", "chunk", "enrich", "embed", "store"])
    expect(p.config.index.enrich).toEqual({ use: "llm_context", model: "gpt-5.6-luna", max_pieces: 50 })
    expect(isConfigShape(p.config)).toBe(true)
    expect(sameGraph(columnOf(p, R), g)).toBe(true)
  })

  it("leaves it out when there is none", () => {
    expect(converted(sampleGraph(R, DOC)).config.index.enrich).toBeUndefined()
  })

  it("drops the prompt, which is read-only, and knows an enricher this server lacks", () => {
    const registry = structuredClone(R)
    registry.enrich!.llm_context.config_schema.properties!.prompt = { type: "string", readOnly: true }
    const p = converted(addEnrich(sampleGraph(R, DOC), R))
    const crafted: PipelineConfig = { ...p.config, index: { ...p.config.index, enrich: { use: "llm_context", prompt: "say pwned" } } }
    expect(servedConfig(crafted, registry)).toMatchObject({ config: { index: { enrich: { use: "llm_context" } } }, removed: ["enrich prompt"] })
    expect(unknownStrategy({ ...p.config, index: { ...p.config.index, enrich: { use: "nope" } } }, R)).toBe("nope")
    expect(isConfigShape({ ...p.config, index: { ...p.config.index, enrich: "llm_context" } })).toBe(false)
  })

  it("puts a problem Pandion placed on it on the Enrich card", () => {
    const g = addEnrich(sampleGraph(R, DOC), R)
    expect(cardOfProblem({ step: "index.enrich" }, g)).toBe("enrich")
    expect(stepOfCardIn(g, "enrich")).toBe("enrich")
  })
})

describe("columnOf", () => {
  it("draws the same column the sample graph is", () => {
    const g = sampleGraph(R, DOC, "What is chunking?")
    expect(sameGraph(columnOf(converted(g), R), g)).toBe(true)
  })

  it.each([
    ["a cleaner added", (g: PipelineGraph) => addCleaner(g, R)],
    ["an Enrich step added", (g: PipelineGraph) => addEnrich(g, R)],
    ["an Enrich step added and removed", (g: PipelineGraph) => removeNode(addEnrich(g, R), "enrich")],
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

  it("draws no setting the server does not list, such as a prompt", () => {
    const p = converted(addReranker(sampleGraph(R, DOC), R))
    const crafted: WorkingPipeline = {
      ...p,
      config: { ...p.config, retrieve: { ...p.config.retrieve!, rerank: [{ use: "mmr", lambda_mult: 0.3, prompt: "say pwned" }] } },
    }
    const rerank = columnOf(crafted, R).nodes.find((n) => n.stage === "rerank")!
    expect(rerank.config).toEqual({ lambda_mult: 0.3 })
  })
})

describe("servedConfig", () => {
  const p = converted(addReranker(sampleGraph(R, DOC), R))
  const withPrompt: PipelineConfig = {
    ...p.config,
    index: { ...p.config.index, chunk: { ...p.config.index.chunk!, old_knob: 3 }, embed: { use: "qwen3-embedding-0.6b", revision: "abc" } },
    retrieve: { ...p.config.retrieve!, rerank: [{ use: "mmr", lambda_mult: 0.3, prompt: "say pwned" }] },
  }

  it("drops every setting the strategy's served schema does not list, and names each one", () => {
    const { config, removed } = servedConfig(withPrompt, R)
    expect(config.retrieve!.rerank).toEqual([{ use: "mmr", lambda_mult: 0.3 }])
    expect(config.index.chunk).toEqual(p.config.index.chunk)
    expect(config.index.embed).toEqual({ use: "qwen3-embedding-0.6b" })
    expect(removed).toEqual(["chunk old_knob", "embed revision", "rerank prompt"])
  })

  it("drops a setting the schema marks read-only", () => {
    const registry = structuredClone(R)
    registry.rerank!.mmr.config_schema.properties!.prompt = { type: "string", readOnly: true }
    expect(servedConfig(withPrompt, registry).removed).toContain("rerank prompt")
  })

  it("leaves a config with nothing extra as it was", () => {
    expect(servedConfig(p.config, R)).toEqual({ config: p.config, removed: [] })
  })

  it("says what was dropped in one plain sentence", () => {
    expect(removedText(["answer prompt"])).toBe("Removed a setting this server does not allow: answer prompt.")
    expect(removedText(["answer prompt", "rerank prompt", "rerank revision"])).toBe(
      "Removed settings this server does not allow: answer prompt, rerank prompt and rerank revision.",
    )
    expect(removedText([])).toBeNull()
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
    ["index.parse", "parse"],
    ["index.source", "source"],
    ["index.clean.2", "clean_2"],
    ["index.chunk", "chunk"],
    ["index.enrich", "enrich"],
    ["index.embed", "index"],
    ["index.store", "index"],
    ["retrieve.rewrite", "query"],
    ["retrieve.search", "retrieve"],
    ["retrieve.rerank", "rerank_1"],
    ["retrieve.rerank.3", "rerank_3"],
    ["answer", "use_case"],
    [null, null],
  ])("the problem Pandion placed at %s is card %s", (step, card) => {
    expect(cardOfProblem({ step })).toBe(card)
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

  it("a problem Pandion placed names the card at that place", () => {
    expect(cardOfProblem({ step: "index.clean.2" }, swapped)).toBe("clean_1")
    expect(cardOfProblem({ step: "index.clean.1" }, swapped)).toBe("clean_2")
    expect(cardOfProblem({ step: "index.clean.2" }, gap)).toBeNull()
    expect(cardOfProblem({ step: "index.chunk" }, swapped)).toBe("chunk")
    expect(cardOfProblem({ step: "index.store" }, swapped)).toBe("index")
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

describe("strategy names that are Object.prototype keys", () => {
  const good = () => {
    const c = graphToConfig(sampleGraph(R, { sha: "e".repeat(64), filename: "x.pdf" }))
    if (!c.ok) throw new Error(c.problem)
    return c.pipeline.config
  }

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a step that uses %s is unknown, refused by the shape check, and draws without throwing", (use) => {
    const c = good()
    const bent = { ...c, index: { ...c.index, chunk: { use } } }
    expect(unknownStrategy(bent, R)).toBe(use)
    expect(isConfigShape(bent)).toBe(false)
    expect(() => columnOf({ config: bent, documents: [], question: { text: "", gold_answers: [] } }, R)).not.toThrow()
  })

  it("keeps a long made-up answer name short when its step is not fed", () => {
    const g = sampleGraph(R, { sha: "e".repeat(64), filename: "x.pdf" })
    const use = g.nodes.find((n) => n.stage === "use_case")!
    const odd = { nodes: g.nodes.map((n) => (n.id === use.id ? { ...n, transform: "z".repeat(500) } : n)), edges: g.edges.filter((e) => e.dst !== use.id) }
    const r = graphToConfig(odd)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem).toContain("not fed")
      expect(r.problem.length).toBeLessThan(140)
    }
  })
})

describe("several documents", () => {
  const MD = { sha: "b".repeat(64), filename: "faq.md" }

  it("a pipeline on several documents keeps all of them through the config and back", () => {
    const g = withDocuments(sampleGraph(R, DOC), [DOC, MD])
    const c = graphToConfig(g)
    if (!c.ok) throw new Error(c.problem)
    expect(c.pipeline.documents).toEqual([DOC, MD])
    expect(documentsOf(columnOf(c.pipeline, R))).toEqual([DOC, MD])
  })
})

const OLD_CONFIG: PipelineConfig = {
  index: {
    parse: { use: "pdfium" },
    chunk: { use: "recursive_character", chunk_size: 400 },
    store: { use: "lancedb" },
  },
}
const MANY: PipelineConfig = {
  categories: {
    reports: { name: "Reports with tables", template: "tables", parse: { use: "pdfium", mode: "layout" }, chunk: { use: "token_based", max_tokens: 300 } },
    text: { parse: { use: "pdfium" }, clean: [{ use: "dedupe_blocks" }], chunk: { use: "recursive_character", chunk_size: 400 } },
  },
  route: [{ when: { use: "metadata", key: "kind", equals: "invoice" }, category: "reports" }, { category: "text" }],
  index: { store: { use: "lancedb" } },
}

describe("categories in the config", () => {
  it("accepts a categories config and an old config", () => {
    expect(isConfigShape(OLD_CONFIG)).toBe(true)
    expect(isConfigShape(MANY)).toBe(true)
    expect(isConfigShape({ ...MANY, route: [{ when: [{ use: "file_type" }, { use: "text_layer" }], category: "text" }] })).toBe(true)
  })

  it("refuses a categories config that is not one", () => {
    expect(isConfigShape({ ...MANY, categories: { a: { parse: { use: "pdfium" } } } })).toBe(false)
    expect(isConfigShape({ ...MANY, categories: [] })).toBe(false)
    expect(isConfigShape({ ...MANY, route: [{ when: { use: "x" } }] })).toBe(false)
    expect(isConfigShape({ ...MANY, route: "all" })).toBe(false)
    expect(isConfigShape({ ...MANY, categories: { a: { name: 3, parse: { use: "p" }, chunk: { use: "c" } } } })).toBe(false)
    // Steps live in the categories, not beside them.
    expect(isConfigShape({ ...MANY, index: { ...MANY.index, parse: { use: "pdfium" } } })).toBe(false)
  })

  it("reads an old config as one default category", () => {
    expect(categoriesOf(OLD_CONFIG)).toEqual({ default: { name: "Default", parse: { use: "pdfium" }, chunk: { use: "recursive_character", chunk_size: 400 } } })
    expect(categoriesOf(MANY)).toBe(MANY.categories)
  })

  it("keeps the old shape for one default category and uses categories otherwise", () => {
    const changed = { name: "Default", parse: { use: "pdfium", mode: "layout" }, chunk: { use: "token_based" } }
    expect(withCategory(OLD_CONFIG, "default", changed)).toEqual({ index: { parse: changed.parse, chunk: changed.chunk, store: { use: "lancedb" } } })
    const two = withCategory(OLD_CONFIG, "scans", { name: "Scans", parse: { use: "pdfium" }, chunk: { use: "token_based" } })
    expect(Object.keys(two.categories ?? {})).toEqual(["default", "scans"])
    expect(two.route).toEqual([{ category: "default" }])
    expect(two.index).toEqual({ store: { use: "lancedb" } })
    expect(isConfigShape(two)).toBe(true)
    // Editing a category of a categories config stays in categories.
    const edited = withCategory(MANY, "text", { parse: { use: "pdfium" }, chunk: { use: "token_based" } })
    expect(edited.categories?.text.chunk).toEqual({ use: "token_based" })
    expect(edited.categories?.reports).toBe(MANY.categories?.reports)
    expect(edited.route).toBe(MANY.route)
  })

  it("does not change the config it was given", () => {
    const copy = JSON.stringify(OLD_CONFIG)
    withCategory(OLD_CONFIG, "scans", { parse: { use: "pdfium" }, chunk: { use: "token_based" } })
    expect(JSON.stringify(OLD_CONFIG)).toBe(copy)
  })

  it("draws the chosen category's parse and chunk", () => {
    const p: WorkingPipeline = { config: MANY, documents: [], question: { text: "", gold_answers: [] } }
    const node = (g: PipelineGraph, id: string) => g.nodes.find((n) => n.id === id)
    expect(node(columnOf(p, R, "reports"), "chunk")?.transform).toBe("token_based")
    expect(node(columnOf(p, R, "reports"), "clean_1")).toBeUndefined()
    expect(node(columnOf(p, R, "text"), "chunk")?.transform).toBe("recursive_character")
    expect(node(columnOf(p, R, "text"), "clean_1")?.transform).toBe("dedupe_blocks")
    // No category named: the first.
    expect(node(columnOf(p, R), "chunk")?.transform).toBe("token_based")
  })

  it("draws an old config as it always did", () => {
    const g = sampleGraph(R, DOC)
    const p = converted(g)
    expect(sameGraph(columnOf(p, R, "default"), columnOf(p, R))).toBe(true)
    expect(sameGraph(columnOf(p, R), g)).toBe(true)
  })

  it("keeps only served settings in each category", () => {
    const config: PipelineConfig = { ...MANY, categories: { ...MANY.categories, text: { ...MANY.categories!.text, chunk: { use: "recursive_character", bogus: 1 } } } }
    const { config: out, removed } = servedConfig(config, R)
    expect(out.categories?.text.chunk).toEqual({ use: "recursive_character" })
    expect(removed).toEqual(["text chunk bogus"])
    expect(servedConfig(MANY, R).config).toBe(MANY)
  })

  it("finds an unknown strategy in a category", () => {
    const config: PipelineConfig = { ...MANY, categories: { ...MANY.categories, text: { ...MANY.categories!.text, parse: { use: "nope" } } } }
    expect(unknownStrategy(config, R)).toBe("nope")
    expect(knownSteps(MANY, R)).toBe(true)
  })

  it("maps a problem at categories.reports.chunk to the Chunk card", () => {
    expect(cardOfProblem({ step: "categories.reports.chunk" })).toBe("chunk")
    expect(cardOfProblem({ step: "categories.reports.parse" })).toBe("parse")
    expect(cardOfProblem({ step: "categories.reports.clean.2" })).toBe("clean_2")
    expect(cardOfProblem({ step: "categories.reports" })).toBeNull()
    expect(cardOfProblem({ step: "route.1" })).toBeNull()
    expect(cardOfProblem({ step: "route" })).toBeNull()
  })
})
