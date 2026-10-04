import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { chunkFinding, recipeNames, retrieveFinding } from "./compare"

const registry = liveRegistry as unknown as Registry

describe("recipeNames", () => {
  it("names chunk recipes by Build's plain names and the size that tells them apart", () => {
    const v = [
      { transform: "recursive_character", config: { chunk_size: 400, chunk_overlap: 80, heading_context: true } },
      { transform: "recursive_character", config: { chunk_size: 200, chunk_overlap: 40, heading_context: true } },
      { transform: "sentence_window", config: { sentences_per_chunk: 5, overlap_sentences: 1 } },
    ]
    const names = recipeNames(v, "chunk", registry)
    expect(names.map((n) => n.name)).toEqual([
      "Recursive (natural breaks), 400 characters",
      "Recursive (natural breaks), 200 characters",
      "By sentence",
    ])
    expect(names.map((n) => n.short)).toEqual(["400 characters", "200 characters", "By sentence"])
    expect(names.map((n) => n.code)).toEqual(["recursive_character", "recursive_character", "sentence_window"])
  })

  it("names search recipes as the Ask panel does", () => {
    const v = ["hybrid_rrf", "dense", "bm25"].map((t) => ({ transform: t, config: { top_k: 20 } }))
    expect(recipeNames(v, "retrieve", registry).map((n) => n.name)).toEqual(["Hybrid (RRF)", "Dense", "BM25"])
  })

  it("reads a null width as the native width", () => {
    const v = [null, 512].map((d) => ({ transform: "lancedb", config: { embedder: "qwen3-embedding-0.6b", truncate_dim: d } }))
    expect(recipeNames(v, "index", registry).map((n) => n.short)).toEqual(["native width", "512 dimensions"])
    expect(recipeNames(v, "index", registry)[1].name).toBe("LanceDB, 512 dimensions")
  })
})

// With the numbers measured on the live sample.
const s = (pieces: number, tokens: number, uncovered: number) => ({ pieces, tokens, median: null, p95: null, overlaps: 0, uncovered })

describe("chunkFinding", () => {
  it("says halving the size doubles the pieces, and names the recipe that leaves nothing out", () => {
    const f = chunkFinding([
      { short: "400 characters", transform: "recursive_character", size: 400, stats: s(6, 351, 10) },
      { short: "200 characters", transform: "recursive_character", size: 200, stats: s(12, 358, 17) },
      { short: "By sentence", transform: "sentence_window", size: 5, stats: s(5, 406, 0) },
    ])
    expect(f!.finding).toBe("Halving the size doubles the pieces, from 6 to 12. By sentence makes the fewest, 5, and is the only recipe that leaves nothing out.")
    expect(f!.sub).toBe("Smaller pieces are tighter matches but carry less context. Ask a question through two of these on Build, or switch to Retrieve to compare searches.")
  })

  it("says plainly when every recipe cut the document the same way", () => {
    const f = chunkFinding([
      { short: "Recursive (natural breaks)", transform: "recursive_character", size: 400, stats: s(1, 351, 0) },
      { short: "By layout block", transform: "layout_blocks", size: 400, stats: s(1, 351, 0) },
    ])
    expect(f!.finding).toBe("Both recipes cut the document the same way, into 1 piece.")
    const three = chunkFinding([0, 1, 2].map(() => ({ short: "x", transform: "token_based", size: 512, stats: s(4, 351, 0) })))
    expect(three!.finding).toBe("All 3 recipes cut the document the same way, into 4 pieces.")
  })

  it("says the size change takes the pieces from one count to another when it is not exactly double", () => {
    const f = chunkFinding([
      { short: "400 characters", transform: "recursive_character", size: 400, stats: s(6, 351, 0) },
      { short: "200 characters", transform: "recursive_character", size: 200, stats: s(11, 358, 0) },
    ])
    expect(f!.finding).toBe("Halving the size takes the pieces from 6 to 11. Every recipe covers the whole document.")
  })

  it("says doubling the size halves the pieces", () => {
    const f = chunkFinding([
      { short: "200 characters", transform: "recursive_character", size: 200, stats: s(12, 358, 0) },
      { short: "400 characters", transform: "recursive_character", size: 400, stats: s(6, 351, 0) },
    ])
    expect(f!.finding).toMatch(/^Doubling the size halves the pieces, from 12 to 6\./)
  })

  it("otherwise lists each recipe's pieces, the node's own as Your pipeline", () => {
    const f = chunkFinding([
      { short: "By layout block", transform: "layout_blocks", size: 400, stats: s(6, 351, 3), own: true },
      { short: "By heading", transform: "markdown_header", size: 512, stats: s(4, 351, 3) },
      { short: "By sentence", transform: "sentence_window", size: 5, stats: s(5, 406, 3) },
    ])
    expect(f!.finding).toBe("Your pipeline makes 6 pieces, By heading makes 4 and By sentence makes 5. By heading makes the fewest, 4.")
  })

  it("says nothing with fewer than two recipes to compare", () => {
    expect(chunkFinding([{ short: "x", transform: "token_based", size: 512, stats: s(4, 351, 0) }])).toBeNull()
  })
})

describe("retrieveFinding", () => {
  it("says all three put the answer first, then what each other search did", () => {
    const hybrid = ["c1", "c4", "c3", "c6", "c5"]
    const f = retrieveFinding([hybrid, ["c1", "c3", "c4", "c6", "c5"], ["c1", "c4"]], ["Hybrid (RRF)", "Dense", "BM25"], [1, 1, 1], 6, ["hybrid_rrf", "dense", "bm25"])
    expect(f!.finding).toBe("All three put the answer first. Dense swaps the 2nd and 3rd pieces, and BM25 returns only 2.")
    expect(f!.sub).toBe("Keyword search only returns pieces that share a word with the question. The other 4 pieces share none.")
  })

  it("never says the answer when the question is not one of the sample's", () => {
    const f = retrieveFinding([["c1", "c2"], ["c1", "c3"]], ["Hybrid (RRF)", "Dense"], [null, null], 6, ["hybrid_rrf", "dense"])
    expect(f!.finding).toMatch(/^Both put the same piece first\./)
    expect(f!.finding).not.toMatch(/answer/)
    expect(f!.sub).toBeNull()
  })

  it("names where each search puts the answer when they differ", () => {
    const f = retrieveFinding(
      [["c1", "c2", "c3"], ["c2", "c3", "c1"], ["c2"]],
      ["Hybrid (RRF)", "Dense", "BM25"],
      [1, 3, null],
      6,
      ["hybrid_rrf", "dense", "bm25"],
    )
    expect(f!.finding).toMatch(/^Hybrid \(RRF\) puts the answer 1st, Dense 3rd and BM25 does not return it\./)
  })

  it("says the same pieces in the same order plainly", () => {
    const f = retrieveFinding([["c1", "c2"], ["c1", "c2"]], ["Hybrid (RRF)", "Dense"], [null, null], 6, ["hybrid_rrf", "dense"])
    expect(f!.finding).toBe("Both put the same piece first. Dense returns the same pieces in the same order.")
  })
})

describe("sentence case in the findings", () => {
  it("starts each sentence with a capital, even when a recipe's short name does not", () => {
    const f = retrieveFinding([["c1", "c2"], ["c1"]], ["native width", "512 dimensions"], [null, null], 6, ["lancedb", "lancedb"])
    expect(f!.finding).toBe("Both put the same piece first. 512 dimensions returns only 1.")
    const g = retrieveFinding([["c1", "c2"], ["c2", "c1"]], ["native width", "512 dimensions"], [2, 1], 6, ["lancedb", "lancedb"])
    expect(g!.finding).toMatch(/^Native width puts the answer 2nd and 512 dimensions 1st\./)
  })
})
