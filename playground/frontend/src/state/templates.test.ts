import { describe, expect, it } from "vitest"

import registryFixture from "@/api/fixtures/registry.json"
import templatesFixture from "@/api/fixtures/templates.json"
import type { Registry } from "@/api/types"

import { columnOf, isConfigShape } from "./config"
import { columnOrder } from "./graph"
import {
  appliedLine,
  COMING_NEXT,
  composeConfig,
  composedRows,
  INDEX_ORDER,
  orderTemplates,
  QUERY_ORDER,
  stepsLine,
  templatePipeline,
  type PipelineTemplates,
} from "./templates"

const registry = registryFixture as unknown as Registry
const T = templatesFixture as unknown as PipelineTemplates
const idx = (id: string) => T.index.find((t) => t.id === id)!
const shared = T.shared
const q = (id: string) => T.query.find((t) => t.id === id)!

describe("composeConfig", () => {
  it("takes the index from the index template and the rest from the query template", () => {
    const c = composeConfig(idx("text"), q("chat"), shared)
    expect(c.index).toEqual({ ...idx("text").pipeline.category, ...shared.index })
    expect(c.retrieve?.search.use).toBe("hybrid_rrf")
    expect(c.answer?.use).toBe("chat")
    expect(isConfigShape(c)).toBe(true)
  })

  it("leaves out a rewrite of none, so the config is one Build holds", () => {
    const c = composeConfig(idx("tables"), q("balanced"), shared)
    expect(c.retrieve && "rewrite" in c.retrieve).toBe(false)
    expect(isConfigShape(c)).toBe(true)
  })

  it("makes the legacy one-category shape from a category template", () => {
    const c = composeConfig(idx("tables"), q("balanced"), shared)
    expect(c.index.parse!.use).toBe("docling")
    expect(c.index.store.use).toBe("lancedb")
  })

  it("keeps a real rewrite step", () => {
    expect(composeConfig(idx("text"), q("vague"), shared).retrieve?.rewrite?.use).toBe("llm_rewrite")
  })
})

describe("composedRows", () => {
  it("lists each stage with the strategy it uses, in column order", () => {
    const rows = composedRows(composeConfig(idx("text"), q("vague"), shared))
    expect(rows).toEqual([
      { stage: "Parse", use: "pdfium" },
      { stage: "Clean", use: "header_footer_strip, dedupe_blocks" },
      { stage: "Chunk", use: "sentence_window" },
      { stage: "Embed", use: "qwen3-embedding-0.6b" },
      { stage: "Store", use: "lancedb" },
      { stage: "Rewrite", use: "llm_rewrite" },
      { stage: "Search", use: "hybrid_rrf" },
      { stage: "Rerank", use: "cross_encoder" },
      { stage: "Answer", use: "search" },
    ])
  })
})

describe("stepsLine", () => {
  it("names the steps a template sets", () => {
    expect(stepsLine(idx("text").pipeline)).toBe("pdfium · header_footer_strip · dedupe_blocks · sentence_window")
    expect(stepsLine(composeConfig(idx("text"), q("balanced"), shared))).toMatch(/sentence_window · qwen3-embedding-0.6b · lancedb/)
    expect(stepsLine(q("chat").pipeline)).toBe("hybrid_rrf · cross_encoder · chat")
    expect(stepsLine(q("vague").pipeline)).toBe("llm_rewrite · hybrid_rrf · cross_encoder · search")
  })
})

describe("orderTemplates", () => {
  it("puts the simplest first, and keeps any unknown template at the end", () => {
    const indexes = orderTemplates(T.index, INDEX_ORDER).map((t) => t.id)
    expect(indexes).toEqual(["text", "tables", "scanned", "manuals", "web"])
    expect(orderTemplates(T.query, QUERY_ORDER).map((t) => t.id)).toEqual(["balanced", "exact", "precision", "vague", "chat"])
    const extra = orderTemplates([...T.index, { ...idx("text"), id: "zzz" }], ["text"]).map((t) => t.id)
    expect(extra[0]).toBe("text")
    expect(extra.at(-1)).toBe("zzz")
  })
})

describe("templatePipeline", () => {
  it("draws the composed config as Build's column, on the documents and question in use", () => {
    const docs = [{ sha: "ab".repeat(32), filename: "report.pdf" }]
    const made = templatePipeline(idx("text"), q("balanced"), shared, { documents: docs, question: { text: "What is it?", gold_answers: [] } }, registry)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const order = columnOrder(made.graph)
    expect(order.find((n) => n.stage === "parse")?.transform).toBe("pdfium")
    expect(order.find((n) => n.stage === "chunk")?.transform).toBe("sentence_window")
    expect(order.find((n) => n.stage === "source")?.config.sha).toBe(docs[0].sha)
    expect(order.find((n) => n.stage === "query")?.config.text).toBe("What is it?")
    expect(made.graph).toEqual(columnOf({ config: composeConfig(idx("text"), q("balanced"), shared), documents: docs, question: { text: "What is it?", gold_answers: [] } }, registry))
  })

  it("says which settings this server does not allow", () => {
    const strict = structuredClone(registry)
    delete strict.chunk!.sentence_window.config_schema.properties!.overlap_sentences
    const made = templatePipeline(idx("text"), q("balanced"), shared, { documents: [], question: { text: "", gold_answers: [] } }, strict)
    expect(made.ok && made.note).toMatch(/chunk overlap_sentences/)
  })

  it("refuses a template whose step this server does not have", () => {
    const { sentence_window: _gone, ...chunks } = registry.chunk!
    const lacking = { ...registry, chunk: chunks }
    const made = templatePipeline(idx("text"), q("balanced"), shared, { documents: [], question: { text: "", gold_answers: [] } }, lacking)
    expect(made).toEqual({ ok: false, problem: "This pipeline uses sentence_window, which this server does not have." })
  })
})

describe("appliedLine and COMING_NEXT", () => {
  it("says what Build now holds", () => {
    expect(appliedLine("Text documents", "Balanced", 9)).toBe("Build now holds Text documents with Balanced: 9 steps.")
  })

  it("keeps the coming card in the playground, with no steps", () => {
    expect(COMING_NEXT.name).toBe("Tables across pages")
    expect(T.index.some((t) => t.id === COMING_NEXT.id)).toBe(false)
  })
})
