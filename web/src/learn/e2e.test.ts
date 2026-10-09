import { describe, expect, it } from "vitest"

import {
  barHeight,
  chunkStep,
  cleanStep,
  hitMeta,
  indexStep,
  listJoin,
  numberWord,
  parseStep,
  previewCaption,
  quoteSource,
  RUN,
  rerankRows,
  rerankStep,
  retrieveStep,
  searchHits,
  snippet,
  topBy,
  type E2ERun,
} from "./e2e"

/**
 * The recorded run, with the reranker's picks changed so it passes over the
 * 2nd chunk and reaches one further down: the variety case. Since the MMR fix
 * (relevance from the retriever's own score) the recorded sample keeps its top
 * picks in order, so this path is built here rather than recorded.
 */
const byRank = [...RUN.pool].sort((a, b) => a.rank - b.rank)
const VARIED: E2ERun = {
  ...RUN,
  mmr: [byRank[0], ...byRank.slice(2, RUN.mmr.length + 1)].map((p) => p.id),
}

/** A small run where the reranker keeps the top two in order. */
const TINY: E2ERun = {
  question: "Why?",
  filename: "a.pdf",
  page_count: 1,
  chunks: [
    { id: "a", ordinal: 0, start: 0, end: 10, page_span: [1, 1], text: "Alpha." },
    { id: "b", ordinal: 1, start: 10, end: 30, page_span: [1, 2], text: "Beta." },
  ],
  pool: [
    { id: "a", rank: 1, score: 0.03, dense: 0.2, bm25: 5 },
    { id: "b", rank: 2, score: 0.02, dense: 0.9, bm25: 1 },
  ],
  mmr: ["a", "b"],
  elements: [{ type: "list_item", page: 1, text: "x" }],
  removed: [],
  index: { model: "m", dim: 8, doc_count: 2 },
  chunker: { chunker: "recursive_character", chunk_size: 400, chunk_overlap: 80 },
}

describe("words and numbers", () => {
  it("spells small counts and joins lists in plain English", () => {
    expect(numberWord(5)).toBe("five")
    expect(numberWord(14)).toBe("fourteen")
    expect(numberWord(21)).toBe("21")
    expect(listJoin(["#3"])).toBe("#3")
    expect(listJoin(["#3", "#6"])).toBe("#3 and #6")
    expect(listJoin(["#3", "#6", "#7"])).toBe("#3, #6 and #7")
  })

  it("drops headings from a snippet and cuts at a word", () => {
    expect(snippet("## Title\n\nOne two three four", 12)).toBe("One two...")
    expect(snippet("Short.", 90)).toBe("Short.")
  })
})

describe("the recorded run", () => {
  it("is the sample, asked the sample question", () => {
    expect(RUN.question).toBe("Why do chunk boundaries matter?")
    expect(RUN.filename).toBe("chunking-primer.pdf")
    expect(RUN.mmr.length).toBeGreaterThan(0)
  })

  it("lists what search found in the reranker's order, with the retriever's rank", () => {
    const hits = searchHits(RUN)
    expect(hits.map((h) => h.id)).toEqual(RUN.mmr)
    expect(hits[0].rank).toBe(RUN.pool.find((p) => p.id === RUN.mmr[0])!.rank)
    expect(hitMeta(hits[0], RUN)).toBe(`page ${hits[0].pages[0]}, ranked ${hits[0].rank} of ${RUN.pool.length} by the retriever`)
  })

  it("says which chunks the reranker passed over and how far down it reached, from the ranks", () => {
    const kept = VARIED.pool.filter((p) => VARIED.mmr.includes(p.id))
    const deepest = Math.max(...kept.map((p) => p.rank))
    const passed = VARIED.pool.filter((p) => !VARIED.mmr.includes(p.id) && p.rank < deepest).map((p) => `#${p.rank}`)
    const step = rerankStep(VARIED)
    expect(step.title).toBe(`Rerank picked a varied ${numberWord(VARIED.mmr.length)}`)
    expect(step.words).toContain(`The retriever ranked all ${VARIED.pool.length} chunks.`)
    expect(step.words.join(" ")).toContain(`It passed over ${listJoin(passed)}`)
    expect(step.words.join(" ")).toContain(`reached down to #${deepest} instead`)
  })

  it("shows the candidates down to the deepest pick, or all of them", () => {
    const step = rerankStep(VARIED)
    const rows = rerankRows(VARIED, false)
    expect(rows.at(-1)!.rank).toBe(step.reached!.rank)
    expect(rows.at(-1)!.why).toBe("picked for variety")
    expect(rows.filter((r) => r.kind === "kept")).toHaveLength(VARIED.mmr.length)
    expect(rows.filter((r) => r.kind === "skipped").every((r) => r.why === "passed over, too similar")).toBe(true)
    expect(rerankRows(VARIED, true)).toHaveLength(VARIED.pool.length)
  })

  it("draws the two rankings from each search's own scores", () => {
    const dense = topBy(RUN, "dense", 4)
    expect(dense).toHaveLength(4)
    expect(dense[0].dense).toBe(Math.max(...RUN.pool.map((p) => p.dense ?? -Infinity)))
    const words = retrieveStep(RUN).words
    expect(words).toContain("The meaning search turned the question into a list of numbers too, and looked for the chunks whose lists are closest.")
    expect(words.join(" ")).not.toContain("the same kind of list")
    expect(words.join(" ")).not.toContain("the index had turned each of the")
  })

  it("names the chunk count and the chunker's settings", () => {
    const step = chunkStep(RUN)
    expect(step.title).toBe(`Chunk cut the document into ${RUN.chunks.length} pieces`)
    expect(step.words.join(" ")).toContain(`up to ${RUN.chunker.chunk_size} characters with ${RUN.chunker.chunk_overlap} characters of overlap`)
  })

  it("names the pages of the removed duplicate", () => {
    const r = RUN.removed[0]
    expect(cleanStep(RUN).words[0]).toBe(`The same paragraph appears on page ${r.duplicate_of_page} and again on page ${r.page}.`)
  })

  it("says so when clean found nothing to remove", () => {
    expect(cleanStep(TINY)).toEqual({
      title: "Clean found nothing to remove",
      words: ["The duplicate cleaner looks for the same paragraph on more than one page.", "This run had none, so nothing was removed."],
    })
  })

  it("explains the index with the model, the chunk count and the size of each list", () => {
    const step = indexStep(RUN)
    expect(step.title).toContain("1024 numbers")
    expect(step.title).toBe(`Index turned each chunk into ${RUN.index.dim} numbers`)
    expect(step.words[0]).toBe(
      `The index asked ${RUN.index.model} to turn each of the ${RUN.index.doc_count} chunks into a list of ${RUN.index.dim} numbers that stands for its meaning.`,
    )
    expect(step.words[1]).toBe("Chunks that say similar things get lists that are close to each other. That closeness is what the meaning search compares.")
  })

  it("says what the variety rerank costs, only when it passed something over", () => {
    const deepest = VARIED.mmr.length + 1
    const cost = `Variety has a cost: #2, which it passed over, speaks to the question directly, and #${deepest} is further from it.`
    expect(rerankStep(VARIED).skipped[0].rank).toBe(2)
    expect(rerankStep(VARIED).reached?.rank).toBe(deepest)
    expect(rerankStep(VARIED).words).toContain(cost)
    const top5 = [...RUN.pool].sort((a, b) => a.rank - b.rank).slice(0, 5).map((p) => p.id)
    const inOrder = { ...RUN, mmr: top5 }
    expect(rerankStep(inOrder).skipped).toHaveLength(0)
    expect(rerankStep(inOrder).words).not.toContain(cost)
  })

  it("counts pages and blocks by type", () => {
    const headings = RUN.elements.filter((e) => e.type === "heading").length
    const words = parseStep(RUN).words[0]
    expect(words.startsWith("Docling, the parser that looks at page layout, read")).toBe(true)
    expect(words).toContain(`Docling, the parser that looks at page layout, read ${RUN.page_count} pages and found ${RUN.elements.length} blocks of text: `)
    expect(words).toContain(`${headings} headings`)
  })

  it("finds the chunk and page a quoted sentence comes from", () => {
    const src = quoteSource(RUN, "A retriever scores each chunk as a whole.")!
    const chunk = RUN.chunks.find((c) => c.text.includes("A retriever scores each chunk as a whole."))!
    expect(src).toEqual({ chunk: chunk.ordinal + 1, page: chunk.page_span[0] })
    expect(quoteSource(RUN, "Not in the document.")).toBeNull()
  })

  it("captions the Home preview with the counts", () => {
    expect(previewCaption(RUN)).toBe(`The sample cut into ${RUN.chunks.length} chunks, and the ${numberWord(RUN.mmr.length)} that answered the question.`)
  })
})

describe("a run where the reranker changed nothing", () => {
  it("says it kept the top ones in order", () => {
    expect(rerankStep(TINY).words.join(" ")).toContain("kept the top two in order")
    expect(rerankStep(TINY).reached).toBeNull()
  })

  it("says the two searches disagreed when they put different chunks first", () => {
    expect(retrieveStep(TINY).words.join(" ")).toContain("put different chunks first")
  })

  it("names pages across a span, other block types, and scales bars to the longest chunk", () => {
    expect(hitMeta(searchHits(TINY)[1], TINY)).toBe("pages 1 to 2, ranked 2 of 2 by the retriever")
    expect(parseStep(TINY).words[0]).toContain("1 list item")
    expect(barHeight(TINY.chunks[1], TINY, 30, 54)).toBe(84)
    expect(barHeight(TINY.chunks[0], TINY, 30, 54)).toBe(57)
  })
})
