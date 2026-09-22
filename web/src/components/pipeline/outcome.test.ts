import { describe, expect, it } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import index from "@/api/fixtures/index.lancedb.json"
import chat from "@/api/fixtures/output.chat.json"
import search from "@/api/fixtures/output.search.json"
import parsedDoc from "@/api/fixtures/parsed_doc.json"
import cleanedDoc from "@/api/fixtures/parsed_doc_cleaned.json"
import hybrid from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import mmr from "@/api/fixtures/retrieval_result.mmr.json"

import { outcomeFor, outcomeText } from "./outcome"

const text = (...a: Parameters<typeof outcomeFor>) => {
  const o = outcomeFor(...a)
  return o ? outcomeText(o) : null
}

describe("what it did, per artifact type", () => {
  it("parsed_doc: elements by type, and pages", () => {
    expect(text("parse", "parsed_doc", parsedDoc)).toBe("Found 20 elements on 3 pages: 20 paragraphs.")
    const mixed = {
      ...parsedDoc,
      elements: [
        ...parsedDoc.elements.slice(0, 3),
        { ...parsedDoc.elements[0], id: "h", type: "heading" },
        { ...parsedDoc.elements[0], id: "l", type: "list_item" },
      ],
    }
    expect(text("parse", "parsed_doc", mixed)).toBe("Found 5 elements on 3 pages: 3 paragraphs, 1 heading and 1 list item.")
  })

  it("a clean step reports its OWN removals, the last report entry", () => {
    expect(text("clean", "parsed_doc", cleanedDoc)).toBe("Removed 1 element, kept 13. Removed 1 paragraph.")
    const strip = { ...cleanedDoc, parser_meta: { ...cleanedDoc.parser_meta, clean_report: cleanedDoc.parser_meta.clean_report.slice(0, 1) } }
    expect(text("clean", "parsed_doc", strip)).toBe("Removed 6 elements, kept 14. Removed 3 page headers and 3 page numbers.")
  })

  it("chunk_set: count, median and largest tokens, overlaps", () => {
    // Tokens 69 76 73 65 62 54: median 67, largest 76.
    expect(text("chunk", "chunk_set", chunkRecursive)).toMatch(/^Made 6 chunks\. Median 67 tokens, largest 76\. \d+ overlaps?\.$/)
    expect(text("chunk", "chunk_set", { ...chunkRecursive, chunks: [] })).toBe("Made 0 chunks. The document produced no text to cut.")
  })

  it("index: embedded versus from cache, and dimensions", () => {
    expect(text("index", "index", index)).toBe("Indexed 6 chunks: 6 embedded, 0 from cache. 384 dimensions.")
    expect(text("index", "index", { ...index, dim: 256, native_dim: 1024, embeddings_cached: 6, embeddings_computed: 0 })).toBe(
      "Indexed 6 chunks: 0 embedded, 6 from cache. 256 of 1,024 dimensions.",
    )
  })

  it("retrieval_result: hits and candidates; a reranker says how many hits moved", () => {
    expect(text("retrieve", "retrieval_result", hybrid)).toBe("Returned 5 hits from 6 candidates.")
    // MMR moved ranks 2..5.
    expect(text("rerank", "retrieval_result", mmr)).toBe("Moved 4 of 5 hits.")
  })

  it("output: search results listed; chat citations and how many are unverified", () => {
    expect(text("use_case", "output", search)).toBe("Listed 5 results from 6 candidates.")
    expect(text("use_case", "output", chat)).toBe("Answered with 5 citations, 2 not verified.")
  })

  it("says nothing for a raw file or an unreadable payload", () => {
    expect(text("source", "raw_file", { sha: "x" })).toBeNull()
    expect(text("chunk", "chunk_set", [])).toBeNull()
  })

  it("(was N) only when the previous headline differs", () => {
    const o = outcomeFor("chunk", "chunk_set", chunkRecursive)!
    expect(outcomeText(o, 9)).toMatch(/^Made 6 chunks \(was 9\)\. Median/)
    expect(outcomeText(o, 6)).not.toContain("was")
    expect(outcomeText(o, null)).not.toContain("was")
  })
})
