import { describe, expect, it } from "vitest"

import {
  addCleaner,
  addReranker,
  askNodes,
  ASK_STAGES,
  COLUMN_STAGES,
  INDEX_STAGES,
  indexNode,
  rerankerOf,
  rewriteOf,
  setReranker,
  setRewrite,
  setUseCase,
  ancestors,
  columnOrder,
  completeGraph,
  defaultConfig,
  effectiveProvides,
  SAMPLE_QUESTION,
  chatSampleGraph,
  e2eSampleGraph,
  sampleGraph,
  initialGraph,
  loadGraph,
  removeNode,
  setConfig,
  setTransform,
  signature,
  titleFor,
  upstreamFor,
  upstreamOfStage,
  type PipelineGraph,
} from "./graph"
import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { compatibility } from "./compat"
import { TEST_REGISTRY as R } from "./testRegistry"

const edgeSet = (g: { edges: { src: string; dst: string; port: string }[] }) =>
  g.edges.map((e) => `${e.src}->${e.dst}:${e.port}`).sort()

/** The retrieval half of the initial column's edges. */
const RETRIEVAL_EDGES = ["chunk->index:chunks", "index->retrieve:index", "retrieve->use_case:result"]

describe("graph state", () => {
  it("starts as the full column, each explicit port wired from the nearest upstream node of its type", () => {
    const g = initialGraph(R)
    expect(columnOrder(g).map((n) => n.stage)).toEqual(["source", "parse", "chunk", "index", "query", "retrieve", "use_case"])
    expect(edgeSet(g)).toEqual(["parse->chunk:doc", "source->parse:file", ...RETRIEVAL_EDGES].sort())
    // Configs start at the schema defaults.
    expect(g.nodes.find((n) => n.stage === "chunk")!.config).toEqual({ chunk_size: 1000, chunk_overlap: 200 })
  })

  it("ambient ports get no edge: the query node has no edges at all", () => {
    const g = initialGraph(R)
    expect(g.edges.some((e) => e.src === "query" || e.port === "query")).toBe(false)
  })

  it("titles are plain verbs, and the use case card is named by its transform", () => {
    const titles = columnOrder(initialGraph(R)).map(titleFor)
    expect(titles).toEqual(["Upload", "Parse", "Chunk", "Index", "Ask", "Retrieve", "Search"])
  })

  it("Retrieve prefers hybrid_rrf when the registry has it, and falls back to the first retriever", () => {
    expect(initialGraph(R).nodes.find((n) => n.stage === "retrieve")!.transform).toBe("hybrid_rrf")
    const noHybrid: Registry = { ...R, retrieve: { dense: R.retrieve!.dense } }
    expect(initialGraph(noHybrid).nodes.find((n) => n.stage === "retrieve")!.transform).toBe("dense")
  })

  it("Parse defaults to docling when the registry has it", () => {
    const withDocling: Registry = {
      ...R,
      parse: { ...R.parse, docling: { ...R.parse!.pdfium, name: "docling", config_schema: { type: "object", title: "doclingConfig", properties: { ocr: { type: "boolean", default: false, title: "Ocr" } } } } },
    }
    const parse = initialGraph(withDocling).nodes.find((n) => n.stage === "parse")!
    expect(parse).toMatchObject({ transform: "docling", config: { ocr: false } })
  })

  it("Parse falls back to the first parser when docling is absent", () => {
    expect(R.parse!.docling).toBeUndefined()
    expect(initialGraph(R).nodes.find((n) => n.stage === "parse")!.transform).toBe("pdfium")
  })

  it("a registry without retrieval stages still gives Load, Parse, Chunk", () => {
    const { source, parse, clean, chunk } = R
    const g = initialGraph({ source, parse, clean, chunk })
    expect(columnOrder(g).map((n) => n.stage)).toEqual(["source", "parse", "chunk"])
    expect(edgeSet(g)).toEqual(["parse->chunk:doc", "source->parse:file"])
  })

  it("adding a cleaner splices it between parse and chunk", () => {
    const g = addCleaner(initialGraph(R), R)
    const order = columnOrder(g)
    expect(order.map((n) => n.stage).slice(0, 4)).toEqual(["source", "parse", "clean", "chunk"])
    const clean = order[2]
    expect(edgeSet(g)).toEqual([`${clean.id}->chunk:doc`, `parse->${clean.id}:doc`, "source->parse:file", ...RETRIEVAL_EDGES].sort())
  })

  it("stacking a second cleaner appends it after the first, and picks an unused cleaner", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1, c2] = columnOrder(g).filter((n) => n.stage === "clean")
    expect(c1.id).not.toBe(c2.id)
    expect(c1.transform).toBe("header_footer_strip")
    expect(c2.transform).toBe("dedupe_blocks")
    expect(edgeSet(g)).toEqual(
      [`parse->${c1.id}:doc`, `${c1.id}->${c2.id}:doc`, `${c2.id}->chunk:doc`, "source->parse:file", ...RETRIEVAL_EDGES].sort(),
    )
  })

  it("removing the middle of a stack reconnects its neighbours", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1, c2] = columnOrder(g).filter((n) => n.stage === "clean")
    const h = removeNode(g, c1.id)
    expect(h.nodes.map((n) => n.id)).not.toContain(c1.id)
    expect(edgeSet(h)).toEqual([`parse->${c2.id}:doc`, `${c2.id}->chunk:doc`, "source->parse:file", ...RETRIEVAL_EDGES].sort())
    expect(edgeSet(removeNode(h, c2.id))).toEqual(edgeSet(initialGraph(R)))
  })

  it("adding a reranker splices it between Retrieve and Search; its query and index stay ambient", () => {
    const g = addReranker(initialGraph(R), R)
    const order = columnOrder(g)
    expect(order.map((n) => n.stage).slice(-4)).toEqual(["query", "retrieve", "rerank", "use_case"])
    const rr = order.find((n) => n.stage === "rerank")!
    expect(rr.transform).toBe("mmr")
    expect(edgeSet(g)).toEqual(
      ["parse->chunk:doc", "source->parse:file", "chunk->index:chunks", "index->retrieve:index", `retrieve->${rr.id}:result`, `${rr.id}->use_case:result`].sort(),
    )
    // No edge into the ambient ports.
    expect(g.edges.filter((e) => e.dst === rr.id).map((e) => e.port)).toEqual(["result"])
  })

  it("rerankers stack, and removing one bridges the gap", () => {
    const g = addReranker(addReranker(initialGraph(R), R), R)
    const [r1, r2] = columnOrder(g).filter((n) => n.stage === "rerank")
    expect(edgeSet(g)).toContain(`retrieve->${r1.id}:result`)
    expect(edgeSet(g)).toContain(`${r1.id}->${r2.id}:result`)
    expect(edgeSet(g)).toContain(`${r2.id}->use_case:result`)
    const h = removeNode(g, r1.id)
    expect(edgeSet(h)).toContain(`retrieve->${r2.id}:result`)
    expect(edgeSet(removeNode(h, r2.id))).toEqual(edgeSet(initialGraph(R)))
  })

  it("new cleaner ids never collide with ids still in the graph", () => {
    let g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1] = columnOrder(g).filter((n) => n.stage === "clean")
    g = addCleaner(removeNode(g, c1.id), R)
    const ids = g.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("changing a transform resets its config to the new defaults and keeps the edges", () => {
    const g = setTransform(initialGraph(R), "chunk", "token_based", R)
    expect(g.nodes.find((n) => n.id === "chunk")).toMatchObject({ transform: "token_based", config: { max_tokens: 256, overlap: 32 } })
    expect(edgeSet(g)).toEqual(edgeSet(initialGraph(R)))
  })

  it("setConfig replaces one node's config only", () => {
    const g = setConfig(initialGraph(R), "chunk", { chunk_size: 400, chunk_overlap: 0 })
    expect(g.nodes.find((n) => n.id === "chunk")!.config).toEqual({ chunk_size: 400, chunk_overlap: 0 })
    expect(g.nodes.find((n) => n.id === "parse")!.config).toEqual({ mode: "text" })
  })

  it("finds ancestors and the nearest upstream node of a stage", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1, c2] = columnOrder(g).filter((n) => n.stage === "clean")
    expect([...ancestors(g, c2.id)].sort()).toEqual(["parse", "source", c1.id].sort())
    expect(upstreamOfStage(g, c2.id, "parse")?.id).toBe("parse")
    expect(upstreamOfStage(g, "parse", "parse")).toBeUndefined()
    expect(upstreamOfStage(g, "use_case", "chunk")?.id).toBe("chunk")
  })

  it("with the registry, ancestors include the ambient query, so a new question makes retrieval stale", () => {
    const g = addReranker(initialGraph(R), R)
    const rr = g.nodes.find((n) => n.stage === "rerank")!.id
    expect(ancestors(g, "retrieve", R).has("query")).toBe(true)
    expect(ancestors(g, rr, R).has("index")).toBe(true)
    const asked = setConfig(g, "query", { text: "a different question" })
    for (const id of ["retrieve", rr, "use_case"]) expect(signature(asked, id, R)).not.toBe(signature(g, id, R))
    for (const id of ["parse", "chunk", "index"]) expect(signature(asked, id, R)).toBe(signature(g, id, R))
  })

  it("completes a stored graph from before retrieval existed", () => {
    const old: PipelineGraph = {
      nodes: initialGraph(R).nodes.filter((n) => ["source", "parse", "chunk"].includes(n.stage)),
      edges: [
        { src: "source", dst: "parse", port: "file" },
        { src: "parse", dst: "chunk", port: "doc" },
      ],
    }
    const g = completeGraph(old, R)
    expect(columnOrder(g).map((n) => n.stage)).toEqual(["source", "parse", "chunk", "index", "query", "retrieve", "use_case"])
    expect(edgeSet(g)).toEqual(edgeSet(initialGraph(R)))
    // A complete graph is returned unchanged.
    expect(completeGraph(g, R)).toBe(g)
  })

  it("loads a stored graph only if every transform still exists", () => {
    const g = addCleaner(initialGraph(R), R)
    expect(loadGraph(JSON.stringify(g), R)).toEqual(g)
    const broken = { ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "gone" } : n)) }
    expect(loadGraph(JSON.stringify(broken), R)).toBeNull()
    expect(loadGraph("not json", R)).toBeNull()
    expect(loadGraph(null, R)).toBeNull()
  })
})

describe("sample graph (plan I-15)", () => {
  const LIVE = liveRegistry as unknown as Registry
  const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

  it("is Load, Parse docling, Clean dedupe_blocks, Chunk recursive_character, Index, Ask, Retrieve hybrid_rrf, Search", () => {
    const g = sampleGraph(LIVE, SRC)
    expect(columnOrder(g).map((n) => [n.stage, n.transform])).toEqual([
      ["source", "upload"],
      ["parse", "docling"],
      ["clean", "dedupe_blocks"],
      ["chunk", "recursive_character"],
      ["index", "lancedb"],
      ["query", "text"],
      ["retrieve", "hybrid_rrf"],
      ["use_case", "search"],
    ])
    // Clean sits between Parse and Chunk.
    expect(edgeSet(g)).toContain("clean_1->chunk:doc")
    expect(edgeSet(g)).toContain("parse->clean_1:doc")
  })

  it("selects the sample source, embeds with Qwen3 and pre-fills the question", () => {
    const g = sampleGraph(LIVE, SRC)
    const by = (stage: string) => g.nodes.find((n) => n.stage === stage)!
    expect(by("source").config).toEqual(SRC)
    expect(by("index").config.embedder).toBe("qwen3-embedding-0.6b")
    // Small enough that the 3-page sample yields a pool larger than what search shows.
    expect(by("chunk").config).toMatchObject({ chunk_size: 400, chunk_overlap: 80 })
    expect(by("query").config.text).toBe(SAMPLE_QUESTION)
    expect(SAMPLE_QUESTION).toBe("Why do chunk boundaries matter?")
  })

  it("leaves every other setting at its schema default", () => {
    const g = sampleGraph(LIVE, SRC)
    const retrieve = g.nodes.find((n) => n.stage === "retrieve")!
    expect(retrieve.config).toEqual(defaultConfig(LIVE.retrieve!.hybrid_rrf))
  })

  it("seeds the given question instead of the primer's, when one is passed (F6)", () => {
    const g = sampleGraph(LIVE, SRC, "What does a scanner actually do to a page?")
    expect(g.nodes.find((n) => n.stage === "query")!.config.text).toBe("What does a scanner actually do to a page?")
  })
})

describe("chat sample graph (Learn > How citations work > Try it yourself)", () => {
  const LIVE = liveRegistry as unknown as Registry
  const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

  it("is the sample graph with a chat step that cites sentence ids, on the registry's default model", () => {
    const g = chatSampleGraph(LIVE, SRC)
    const chat = g.nodes.find((n) => n.stage === "use_case")!
    expect(chat.transform).toBe("chat")
    expect(chat.config.citation_method).toBe("sentence_ids")
    expect(chat.config.model).toBe(LIVE.use_case!.chat.config_schema.properties!.model.default)
    expect(g.nodes.find((n) => n.stage === "source")!.config).toEqual(SRC)
    expect(g.nodes.find((n) => n.stage === "query")!.config.text).toBe(SAMPLE_QUESTION)
  })

  it("falls back to the plain sample graph when the registry has no chat step", () => {
    const g = chatSampleGraph(R, SRC)
    expect(g.nodes.find((n) => n.stage === "use_case")!.transform).toBe("search")
  })
})

describe("end-to-end sample graph (Learn > How RAG works > Run it yourself)", () => {
  const LIVE = liveRegistry as unknown as Registry
  const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

  it("is the sample graph with MMR between Retrieve and Search, the run the lesson recorded", () => {
    const g = e2eSampleGraph(LIVE, SRC)
    expect(columnOrder(g).map((n) => [n.stage, n.transform])).toEqual([
      ["source", "upload"],
      ["parse", "docling"],
      ["clean", "dedupe_blocks"],
      ["chunk", "recursive_character"],
      ["index", "lancedb"],
      ["query", "text"],
      ["retrieve", "hybrid_rrf"],
      ["rerank", "mmr"],
      ["use_case", "search"],
    ])
    expect(edgeSet(g)).toContain("retrieve->rerank_1:result")
    expect(edgeSet(g)).toContain("rerank_1->use_case:result")
    expect(g.nodes.find((n) => n.stage === "rerank")!.config).toEqual(defaultConfig(LIVE.rerank!.mmr))
  })
})

describe("upstreamFor", () => {
  it("maps each input port of a node to the transform feeding it", () => {
    const g = initialGraph(R)
    expect(upstreamFor(g, R, "chunk").doc?.name).toBe("pdfium")
    expect(upstreamFor(g, R, "retrieve").index?.name).toBe("lancedb")
    expect(upstreamFor(g, R, "parse").file?.name).toBe("upload")
  })

  it("resolves an ambient port from the column, the way the server binds it", () => {
    const g = initialGraph(R)
    expect(upstreamFor(g, R, "retrieve").query?.name).toBe("text")
  })

  it("leaves a port out when nothing feeds it", () => {
    const g = initialGraph(R)
    expect(upstreamFor(g, R, "source")).toEqual({})
    expect(upstreamFor(g, R, "nope")).toEqual({})
  })
})

describe("effective provides: capabilities pass through Clean", () => {
  const LIVE = liveRegistry as unknown as Registry
  const SRC = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
  const headings = LIVE.chunk!.markdown_header

  it("sees Docling's headings behind a Clean step", () => {
    const g = sampleGraph(LIVE, SRC) // Docling -> dedupe_blocks -> Chunk
    expect(upstreamFor(g, LIVE, "chunk").doc?.name).toBe("dedupe_blocks")
    expect(effectiveProvides(g, LIVE, "clean_1")).toEqual({ structure: ["headings"] })
    expect(compatibility(headings, upstreamFor(g, LIVE, "chunk"))).toEqual({ kind: "ok" })
  })

  it("still falls back behind pdfium and a Clean step", () => {
    const g = setTransform(sampleGraph(LIVE, SRC), "parse", "pdfium", LIVE)
    expect(compatibility(headings, upstreamFor(g, LIVE, "chunk")).kind).toBe("soft")
  })

  it("is still ok with Docling wired straight into Chunk", () => {
    const g = setTransform(initialGraph(LIVE), "parse", "docling", LIVE)
    expect(upstreamFor(g, LIVE, "chunk").doc?.name).toBe("docling")
    expect(compatibility(headings, upstreamFor(g, LIVE, "chunk"))).toEqual({ kind: "ok" })
  })

  it("lets a step's own provides win over its upstream's on the same key", () => {
    const dedupe = LIVE.clean!.dedupe_blocks
    const reg: Registry = { ...LIVE, clean: { ...LIVE.clean, dedupe_blocks: { ...dedupe, provides: { structure: [] } } } }
    const g = sampleGraph(reg, SRC)
    expect(effectiveProvides(g, reg, "clean_1")).toEqual({ structure: [] })
    expect(compatibility(headings, upstreamFor(g, reg, "chunk")).kind).toBe("soft")
  })
})

describe("ask panel helpers", () => {
  const LIVE = liveRegistry as unknown as Registry
  const SRC = { sha: "ef".repeat(32), filename: "primer.pdf" }

  it("splits the stages into Index and Ask halves that add up to the column", () => {
    expect(INDEX_STAGES).toEqual(["source", "parse", "clean", "chunk", "index"])
    expect(ASK_STAGES).toEqual(["query", "retrieve", "rerank", "use_case"])
    expect([...INDEX_STAGES, ...ASK_STAGES]).toEqual(COLUMN_STAGES)
  })

  it("askNodes finds the four Ask nodes, with no reranker on the sample graph", () => {
    const a = askNodes(sampleGraph(LIVE, SRC))
    expect(a.query?.stage).toBe("query")
    expect(a.retrieve?.stage).toBe("retrieve")
    expect(a.rerank).toBeUndefined()
    expect(a.useCase?.stage).toBe("use_case")
  })

  it("askNodes finds the reranker on the end-to-end graph", () => {
    expect(askNodes(e2eSampleGraph(LIVE, SRC)).rerank?.transform).toBe("mmr")
  })

  it("indexNode is the index card, and undefined with no Index-stage node", () => {
    const g = sampleGraph(LIVE, SRC)
    expect(indexNode(g)?.stage).toBe("index")
    expect(indexNode({ nodes: g.nodes.filter((n) => ASK_STAGES.includes(n.stage)), edges: [] })).toBeUndefined()
    // Without an Index card the last index-stage node is Chunk, so Build the index still has a target.
    expect(indexNode({ nodes: g.nodes.filter((n) => n.stage !== "index"), edges: [] })?.stage).toBe("chunk")
  })

  it("rerankerOf names the reranker or gives null", () => {
    expect(rerankerOf(sampleGraph(LIVE, SRC))).toBeNull()
    expect(rerankerOf(e2eSampleGraph(LIVE, SRC))).toBe("mmr")
  })

  it("setReranker adds a reranker when there is none", () => {
    const g = setReranker(sampleGraph(LIVE, SRC), LIVE, "cross_encoder")
    expect(rerankerOf(g)).toBe("cross_encoder")
    expect(g.nodes.filter((n) => n.stage === "rerank")).toHaveLength(1)
    expect(edgeSet(g)).toContain("retrieve->rerank_1:result")
    expect(edgeSet(g)).toContain("rerank_1->use_case:result")
  })

  it("setReranker switches the transform and resets its config to the defaults", () => {
    const g0 = e2eSampleGraph(LIVE, SRC)
    const id = g0.nodes.find((n) => n.stage === "rerank")!.id
    const g = setReranker(setConfig(g0, id, { lambda_mult: 0.9 }), LIVE, "llm_rerank")
    const node = g.nodes.find((n) => n.stage === "rerank")!
    expect(node.transform).toBe("llm_rerank")
    expect(node.config).toEqual(defaultConfig(LIVE.rerank!.llm_rerank))
    expect(g.nodes.filter((n) => n.stage === "rerank")).toHaveLength(1)
  })

  it("setReranker(null) removes the reranker and bridges Retrieve to Search", () => {
    const g = setReranker(e2eSampleGraph(LIVE, SRC), LIVE, null)
    expect(rerankerOf(g)).toBeNull()
    expect(edgeSet(g)).toContain("retrieve->use_case:result")
    expect(edgeSet(g).some((e) => e.includes("rerank"))).toBe(false)
  })

  it("an old pipeline with stacked rerankers: the panel edits the one feeding the use case, and None means none", () => {
    const g = addReranker(addReranker(sampleGraph(LIVE, SRC), LIVE), LIVE)
    const [, second] = columnOrder(g).filter((n) => n.stage === "rerank")
    expect(askNodes(g).rerank!.id).toBe(second.id)
    const none = setReranker(g, LIVE, null)
    expect(none.nodes.filter((n) => n.stage === "rerank")).toHaveLength(0)
    expect(edgeSet(none)).toContain("retrieve->use_case:result")
    const one = setReranker(g, LIVE, "cross_encoder")
    const left = one.nodes.filter((n) => n.stage === "rerank")
    expect(left).toHaveLength(1)
    expect(left[0].transform).toBe("cross_encoder")
    expect(edgeSet(one)).toContain(`retrieve->${left[0].id}:result`)
    expect(edgeSet(one)).toContain(`${left[0].id}->use_case:result`)
  })

  it("setReranker(null) on a graph with no reranker changes nothing", () => {
    const g = sampleGraph(LIVE, SRC)
    expect(setReranker(g, LIVE, null)).toEqual(g)
  })

  it("Cross-encoder to None and back leaves one rerank node and the others' config alone", () => {
    const g0 = sampleGraph(LIVE, SRC)
    const edited = (x: PipelineGraph) => {
      const a = askNodes(x)
      return [a.retrieve!, a.useCase!].map((n) => ({ id: n.id, transform: n.transform, config: n.config }))
    }
    const tuned = setConfig(g0, askNodes(g0).retrieve!.id, { ...askNodes(g0).retrieve!.config, top_k: 7 })
    const before = edited(tuned)
    const on = setReranker(tuned, LIVE, "cross_encoder")
    const off = setReranker(on, LIVE, null)
    const back = setReranker(off, LIVE, "cross_encoder")
    expect(back.nodes.filter((n) => n.stage === "rerank")).toHaveLength(1)
    expect(rerankerOf(back)).toBe("cross_encoder")
    expect(edited(back)).toEqual(before)
    expect(edited(off)).toEqual(before)
  })

  it("an old graph, with no rewrite fields, loads as no rewrite", () => {
    const g = sampleGraph(LIVE, SRC)
    const retrieve = askNodes(g).retrieve!
    const { query_expansion: _q, prf_docs: _d, prf_terms: _t, ...old } = retrieve.config
    const stored = JSON.stringify(setConfig(g, retrieve.id, old))
    expect(rewriteOf(loadGraph(stored, LIVE)!)).toBe("none")
    expect(rewriteOf(g)).toBe("none")
  })

  it("setRewrite prf turns on query_expansion and keeps the question", () => {
    const g0 = sampleGraph(LIVE, SRC, "Who is my current employer?")
    const g = setRewrite(g0, LIVE, "prf")
    expect(rewriteOf(g)).toBe("prf")
    expect(askNodes(g).retrieve!.config.query_expansion).toBe("prf")
    expect(askNodes(g).query).toEqual(askNodes(g0).query)
  })

  it("setRewrite prf switches the strategy to hybrid search first", () => {
    const g0 = sampleGraph(LIVE, SRC)
    const dense = setTransform(g0, askNodes(g0).retrieve!.id, "dense", LIVE)
    const g = setRewrite(dense, LIVE, "prf")
    expect(askNodes(g).retrieve!.transform).toBe("hybrid_rrf")
    expect(rewriteOf(g)).toBe("prf")
  })

  it("setRewrite llm swaps the query transform and keeps the question and gold answers", () => {
    const g0 = sampleGraph(LIVE, SRC, "Who is my current employer?")
    const q = askNodes(g0).query!
    const withGold = setConfig(g0, q.id, { ...q.config, gold_answer: "Present" })
    const g = setRewrite(setRewrite(withGold, LIVE, "prf"), LIVE, "llm")
    expect(rewriteOf(g)).toBe("llm")
    const query = askNodes(g).query!
    expect(query.transform).toBe("llm_rewrite")
    expect(query.config.text).toBe("Who is my current employer?")
    expect(query.config.gold_answer).toBe("Present")
    expect(query.config.style).toBe("document words")
    expect(askNodes(g).retrieve!.config.query_expansion).toBe("none")
  })

  it("setRewrite none puts back the plain question and turns PRF off", () => {
    const g0 = sampleGraph(LIVE, SRC, "Who is my current employer?")
    const back = setRewrite(setRewrite(g0, LIVE, "llm"), LIVE, "none")
    expect(rewriteOf(back)).toBe("none")
    expect(askNodes(back).query).toEqual(askNodes(g0).query)
    const off = setRewrite(setRewrite(g0, LIVE, "prf"), LIVE, "none")
    expect(askNodes(off).retrieve!.config.query_expansion).toBe("none")
  })

  it("setUseCase switches between search and chat", () => {
    const g = setUseCase(sampleGraph(LIVE, SRC), LIVE, "chat")
    expect(askNodes(g).useCase?.transform).toBe("chat")
    expect(askNodes(setUseCase(g, LIVE, "search")).useCase?.transform).toBe("search")
  })
})
