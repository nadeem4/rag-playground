import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry, Stage } from "@/api/types"

import { recipeSentence, type SentencePart } from "./recipeSentence"

const registry = liveRegistry as unknown as Registry
const say = (parts: SentencePart[]) => parts.map((p) => p.text).join("")
const schemaOf = (stage: Stage, t: string) => registry[stage]![t].config_schema

describe("recipeSentence", () => {
  it("says a Recursive recipe as one sentence, every value a part that can change", () => {
    const parts = recipeSentence({ transform: "recursive_character", config: { chunk_size: 400, chunk_overlap: 80, heading_context: true } }, schemaOf("chunk", "recursive_character"), "Recursive (natural breaks)")
    expect(say(parts)).toBe("Cut with Recursive (natural breaks) into pieces of 400 characters, overlapping 80 characters. Heading context is on.")
    expect(parts.filter((p) => p.field).map((p) => p.field)).toEqual(["transform", "chunk_size", "chunk_overlap", "heading_context"])
  })

  it("adds a sentence for each shown field the template leaves out", () => {
    const v = { transform: "layout_blocks", config: { max_tokens: 400, keep_tables_whole: true, heading_context: true, section_level: 6 } }
    expect(say(recipeSentence(v, schemaOf("chunk", "layout_blocks"), "By layout block"))).toBe(
      "Cut By layout block, up to 400 tokens a piece, starting a new piece at headings down to level 6. Keep tables whole is on. Heading context is on.",
    )
  })

  it("falls back to Use and one sentence per field for a strategy with no template", () => {
    expect(say(recipeSentence({ transform: "pdfium", config: { mode: "text", join_lines: true } }, schemaOf("parse", "pdfium"), "Fast text"))).toMatch(/^Use Fast text\. .*Join lines is on\.$/)
  })

  it("says a size of one in the singular, a search's pieces, and a query rewrite by its label", () => {
    expect(say(recipeSentence({ transform: "sentence_window", config: { sentences_per_chunk: 1, overlap_sentences: 0 } }, schemaOf("chunk", "sentence_window"), "By sentence"))).toBe(
      "Cut By sentence, 1 sentence to a piece, overlapping 0 sentences.",
    )
    expect(say(recipeSentence({ transform: "hybrid_rrf", config: { top_k: 20, rrf_k: 60, query_expansion: "none", prf_docs: 2, prf_terms: 6 } }, schemaOf("retrieve", "hybrid_rrf"), "Hybrid (RRF)"))).toMatch(
      /^Search with Hybrid \(RRF\), keeping 20 pieces, fused with RRF k 60\. Query rewrite is off\./,
    )
  })
})
