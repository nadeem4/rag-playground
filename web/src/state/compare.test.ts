import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import type { NodeState, VariantState } from "@/api/runState"

import {
  chunkFinding,
  chunkManyFinding,
  columnDelta,
  MAX_RECIPES,
  planSentence,
  recipeNames,
  recipeStatus,
  retrieveFinding,
  retrieveManyFinding,
  sharedTop,
  sortRecipes,
  statusText,
} from "./compare"
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

describe("recipeStatus", () => {
  const ids = { targetId: "chunk", throughId: "chunk", upstream: ["source", "parse"], stopped: false }
  const v = (nodes: Record<string, Partial<NodeState>>): VariantState => ({ index: 0, order: Object.keys(nodes), nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { id, status: "pending", ...n }])) })

  it("waits until its variant starts", () => {
    expect(recipeStatus(undefined, 1, ids)).toEqual({ kind: "waiting" })
  })
  it("runs the shared steps on the first recipe, and finds them in the cache after", () => {
    expect(recipeStatus(v({ parse: { status: "running" } }), 0, ids)).toEqual({ kind: "running", shared: true, cached: false })
    expect(recipeStatus(v({ parse: { status: "cached", cache_hit: true }, chunk: { status: "running" } }), 1, ids)).toEqual({ kind: "running", shared: false, cached: true })
  })
  it("is done when the step it runs through finishes", () => {
    expect(recipeStatus(v({ parse: { status: "cached" }, chunk: { status: "done" } }), 1, ids)).toEqual({ kind: "done" })
  })
  it("names the step that failed and its error headline", () => {
    const s = recipeStatus(v({ chunk: { status: "failed", error: "Traceback (most recent call last):\nValueError: overlap must be smaller" } }), 2, ids)
    expect(s).toEqual({ kind: "failed", step: "Chunk", error: "ValueError: overlap must be smaller" })
  })
  it("says a recipe the run never reached was stopped", () => {
    expect(recipeStatus(undefined, 4, { ...ids, stopped: true })).toEqual({ kind: "stopped" })
  })
})

describe("statusText", () => {
  it("says each state in a full sentence, with the seconds the browser counted", () => {
    expect(statusText({ kind: "waiting" }, null)).toBe("Waiting. It starts when the recipe before it finishes.")
    expect(statusText({ kind: "running", shared: true, cached: false }, 12)).toBe("Running the shared steps, then this recipe, 12 s")
    expect(statusText({ kind: "running", shared: false, cached: true }, 1)).toBe("Running. The shared steps came from the cache, 1 s")
    expect(statusText({ kind: "running", shared: false, cached: false }, 1)).toBe("Running this recipe, 1 s")
    expect(statusText({ kind: "failed", step: "Chunk", error: "ValueError: x" }, null)).toBe("Failed at Chunk. ValueError: x")
    expect(statusText({ kind: "stopped" }, null)).toBe("Not run. The run was stopped first.")
  })
})

describe("the many-recipe findings", () => {
  const st = (pieces: number, uncovered: number) => ({ pieces, tokens: 345, median: 14, p95: 30, overlaps: 0, uncovered })
  const seven = [
    { i: 0, phrase: "Your pipeline", stats: st(6, 10) },
    { i: 1, phrase: "Recursive at 200 characters", stats: st(12, 17) },
    { i: 2, phrase: "By sentence at 5", stats: st(5, 0) },
    { i: 3, phrase: "By layout block", stats: st(4, 0) },
    { i: 4, phrase: "Recursive at 800 characters", stats: st(3, 4) },
    { i: 5, phrase: "Recursive at 100 characters", stats: st(24, 34) },
    { i: 6, phrase: "By sentence at 2", stats: st(11, 0) },
  ]

  it("names the extremes of a chunk run of seven", () => {
    const f = chunkManyFinding(seven)!
    expect(f.finding).toBe("From 3 to 24 pieces. Recursive at 100 characters cuts the most, and Recursive at 800 characters makes the fewest. Three of the seven leave nothing out.")
    expect(f.extremes).toEqual([5, 4])
    expect(f.link).toBe("Read the two extremes side by side")
    expect(f.sub).toBe("Smaller pieces match more tightly but carry less context. Pick up to three recipes to read their pieces side by side.")
    expect(chunkManyFinding(seven, 1)!.sub).toBe("Smaller pieces match more tightly but carry less context. Open any recipe to read its pieces.")
  })

  it("says who leaves nothing out when one, all or none do", () => {
    expect(chunkManyFinding(seven.map((x) => ({ ...x, stats: st(x.stats.pieces, x.i === 2 ? 0 : 5) })))!.finding).toMatch(/ Only By sentence at 5 leaves nothing out\.$/)
    expect(chunkManyFinding(seven.map((x) => ({ ...x, stats: st(x.stats.pieces, 0) })))!.finding).toMatch(/ None leaves anything out\.$/)
    expect(chunkManyFinding(seven.map((x) => ({ ...x, stats: st(x.stats.pieces, 5) })))!.finding).toMatch(/ Every recipe leaves something out\.$/)
  })

  const search = (i: number, phrase: string, shared: number | null, returned: number, rank: number | null = null, transform = "dense", topK = 20) => ({ i, phrase, shared, returned, rank, transform, topK, own: i === 0 })
  const sevenSearches = [
    search(0, "Your pipeline", null, 20, 1, "hybrid_rrf"),
    search(1, "Dense", 4, 20, 2),
    search(2, "BM25", 3, 2, 1, "bm25"),
    search(3, "Hybrid (RRF) with RRF k 10", 5, 20, 1, "hybrid_rrf"),
    search(4, "Hybrid (RRF) with PRF", 5, 20, 1, "hybrid_rrf"),
    search(5, "Dense with top 1", 1, 1, null, "dense", 1),
    search(6, "Hybrid (RRF) with RRF k 200", 5, 20, 1, "hybrid_rrf"),
  ]

  it("leads a search run with Shared and Returned when the answer is not known", () => {
    const f = retrieveManyFinding(sevenSearches, false)!
    expect(f.finding).toMatch(/^Four of seven share all 5 pieces with Your pipeline\./)
    expect(f.finding).toBe("Four of seven share all 5 pieces with Your pipeline. Dense with top 1 shares the fewest, 1 of 5, and BM25 returns only 2.")
    expect(f.finding).not.toMatch(/answer/)
    expect(f.link).toBe("Read Your pipeline beside Dense with top 1")
    expect(f.extremes).toEqual([0, 5])
    expect(f.sub).toBe("Keyword search only returns pieces that share a word with the question. Pick up to three recipes to read their lists side by side.")
  })

  it("leads with the answer when it is known, then up to two notes", () => {
    const f = retrieveManyFinding(sevenSearches, true)!
    expect(f.finding).toBe("Five of seven put the answer first. Dense with top 1 does not return it, and Dense puts it 2nd.")
    expect(f.link).toBe("Read Your pipeline beside Dense with top 1")
  })
})

describe("sortRecipes and sharedTop", () => {
  const row = (i: number, pieces: number | null, kind: string) => ({ i, done: kind === "done", values: { pieces } })

  it("keeps unfinished rows last in recipe order, and Your pipeline in the sort", () => {
    const rows = [row(0, 6, "done"), row(1, 12, "done"), row(2, null, "running"), row(3, 24, "done"), row(4, null, "waiting")]
    expect(sortRecipes(rows, "pieces", -1).map((r) => r.i)).toEqual([3, 1, 0, 2, 4])
    expect(sortRecipes(rows, "pieces", 1).map((r) => r.i)).toEqual([0, 1, 3, 2, 4])
    expect(sortRecipes(rows, "order", 1).map((r) => r.i)).toEqual([0, 1, 2, 3, 4])
  })

  it("counts how many of a list's top 5 are in the baseline's top 5", () => {
    expect(sharedTop(["a", "b", "c", "d", "e", "f"], ["b", "x", "a", "f", "e"])).toBe(3)
  })
})

describe("columnDelta", () => {
  const st = (pieces: number, uncovered: number) => ({ pieces, tokens: 345, median: 14, p95: 30, overlaps: 0, uncovered })

  it("says a chunk column against Your pipeline", () => {
    expect(columnDelta({ kind: "chunk", stats: st(24, 34), base: st(6, 8) })).toBe("18 more pieces than Your pipeline, and 26 more characters left out.")
    expect(columnDelta({ kind: "chunk", stats: st(5, 0), base: st(6, 8) })).toBe("1 fewer piece than Your pipeline, and nothing left out.")
    expect(columnDelta({ kind: "chunk", stats: st(6, 8), base: st(6, 8) })).toBe("The same number of pieces as Your pipeline.")
  })

  it("says a search column against Your pipeline, the answer only when it is known", () => {
    expect(columnDelta({ kind: "retrieve", shared: 4, top: 5, rank: 2, goldKnown: true, returned: 20 })).toBe("Shares 4 of 5 pieces with Your pipeline. Puts the answer 2nd.")
    expect(columnDelta({ kind: "retrieve", shared: 2, top: 5, rank: null, goldKnown: false, returned: 2 })).toBe("Shares 2 of 5 pieces with Your pipeline. Returns 2, not 5.")
  })
})
