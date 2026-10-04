import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { chunkFinding, MAX_RECIPES, planSentence, recipeNames, retrieveFinding } from "./compare"
import { defaultConfig } from "./graph"

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

describe("recipeNames for many recipes", () => {
  const recipe = (t: string, c: Record<string, unknown> = {}) => ({ transform: t, config: { ...defaultConfig(registry.retrieve![t]), ...c } })

  it("takes at most ten recipes", () => {
    expect(MAX_RECIPES).toBe(10)
  })

  it("gives ten search recipes ten names, leaving out values at their defaults", () => {
    const v = [
      recipe("hybrid_rrf"), recipe("dense"), recipe("bm25"), recipe("hybrid_rrf", { rrf_k: 10 }), recipe("hybrid_rrf", { query_expansion: "prf" }),
      recipe("hybrid_rrf", { rrf_k: 200 }), recipe("dense", { top_k: 3 }), recipe("bm25", { top_k: 1 }), recipe("dense", { top_k: 1 }),
      recipe("hybrid_rrf", { rrf_k: 20, query_expansion: "prf" }),
    ]
    const names = recipeNames(v, "retrieve", registry, 0)
    expect(new Set(names.map((n) => n.name)).size).toBe(10)
    expect(names.map((n) => n.name).slice(0, 5)).toEqual(["Hybrid (RRF)", "Dense", "BM25", "Hybrid (RRF), RRF k 10", "Hybrid (RRF) with PRF"])
    expect(names[8].name).toBe("Dense, top 1")
    expect(names[8].phrase).toBe("Dense with top 1")
    expect(names[0].phrase).toBe("Your pipeline")
  })

  it("says chunk recipes in the short phrases the findings use", () => {
    const v = [
      { transform: "recursive_character", config: { chunk_size: 100, chunk_overlap: 20, heading_context: true } },
      { transform: "sentence_window", config: { sentences_per_chunk: 2, overlap_sentences: 0 } },
      { transform: "token_based", config: { max_tokens: 96, overlap: 16 } },
      { transform: "layout_blocks", config: { max_tokens: 400, keep_tables_whole: true, heading_context: true, section_level: 6 } },
    ]
    expect(recipeNames(v, "chunk", registry).map((n) => n.phrase)).toEqual(["Recursive at 100 characters", "By sentence at 2", "Fixed 96-token pieces", "By layout block"])
  })

  it("marks a recipe that repeats an earlier one", () => {
    const v = [recipe("dense"), recipe("dense")]
    expect(recipeNames(v, "retrieve", registry).map((n) => n.name)).toEqual(["Dense", "Dense, copy 2"])
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
    const f = retrieveFinding([hybrid, ["c1", "c3", "c4", "c6", "c5"], ["c1", "c4"]], ["Hybrid (RRF)", "Dense", "BM25"], [1, 1, 1], 6, ["hybrid_rrf", "dense", "bm25"], { topKs: [20, 20, 20] })
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

describe("measured counts only", () => {
  const lists = [["c1", "c4", "c3", "c6", "c5"], ["c1", "c3", "c4", "c6", "c5"], ["c1", "c4"]]
  const names = ["Hybrid (RRF)", "Dense", "BM25"]
  const transforms = ["hybrid_rrf", "dense", "bm25"]

  it("says no other piece shares a word only when BM25 returned fewer than it was asked for", () => {
    const f = retrieveFinding(lists, names, [1, 1, 1], 6, transforms, { topKs: [20, 20, 20] })
    expect(f!.sub).toBe("Keyword search only returns pieces that share a word with the question. The other 4 pieces share none.")
  })

  it("says nothing about shared words when BM25 returned all it was asked for", () => {
    const f = retrieveFinding(lists, names, [1, 1, 1], 6, transforms, { topKs: [20, 20, 2] })
    expect(f!.finding).toBe("All three put the answer first. Dense swaps the 2nd and 3rd pieces, and BM25 returns only 2.")
    expect(f!.sub).toBeNull()
  })

  it("says none of them returns the answer when the answer is known and no list holds it", () => {
    const f = retrieveFinding([["c1", "c2"], ["c1", "c3"]], ["Hybrid (RRF)", "Dense"], [null, null], 6, ["hybrid_rrf", "dense"], { goldKnown: true })
    expect(f!.finding).toMatch(/^Neither returns the answer\. /)
    const three = retrieveFinding(lists, names, [null, null, null], 6, transforms, { goldKnown: true })
    expect(three!.finding).toMatch(/^None of them returns the answer\. /)
  })
})

describe("planSentence", () => {
  const rc = (size: number, own = false) => ({ phrase: own ? "Your pipeline" : `Recursive at ${size} characters`, transform: "recursive_character", config: { chunk_size: size } })
  const other = (phrase: string, transform: string) => ({ phrase, transform, config: {} })
  const sevenChunkItems = [rc(400, true), rc(200), other("By sentence at 5", "sentence_window"), other("By layout block", "layout_blocks"), rc(800), rc(100), other("Fixed 96-token pieces", "token_based")]

  it("names the pattern when many recipes vary the size, and says the results open as a table", () => {
    const p = planSentence("chunk", sevenChunkItems, "overview", 3)
    expect(p.plan).toBe("You are about to see how size changes the pieces, from 100 to 800 characters, and how three other strategies compare.")
    expect(p.sub).toBe("After the run, the seven recipes open as a table you can sort, and you pick up to three to read side by side.")
    expect(planSentence("chunk", sevenChunkItems, "overview", 1).sub).toBe("After the run, the seven recipes open as a table you can sort, and you open any one to read it.")
  })

  it("lists three recipes or fewer, and says each becomes a column or a tab", () => {
    const three = [rc(400, true), rc(200), other("By sentence at 5", "sentence_window")]
    const p = planSentence("chunk", three, "columns", 3)
    expect(p.plan).toBe("You are about to compare your pipeline, Recursive at 200 characters and By sentence at 5.")
    expect(p.sub).toBe("After the run, each recipe becomes a column with its pieces, numbers and a chunk bar, and a sentence up here says what changed.")
    expect(planSentence("chunk", three, "tabs", 1).sub).toMatch(/^After the run, each recipe gets a tab with its pieces/)
  })

  it("counts the ways on Retrieve, and runs one recipe on its own", () => {
    const five = ["Your pipeline", "Dense", "BM25", "Dense with top 3", "BM25 with top 1"].map((x) => other(x, "dense"))
    expect(planSentence("retrieve", five, "overview", 2).plan).toBe("You are about to compare five ways to search the same pieces.")
    expect(planSentence("chunk", [rc(400, true)], "columns", 3)).toEqual({ plan: "You are about to run your pipeline on its own. Add a recipe to compare it with.", sub: null })
  })
})
