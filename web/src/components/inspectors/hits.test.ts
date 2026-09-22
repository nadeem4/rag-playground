import { describe, expect, it } from "vitest"

import chunkJson from "@/api/fixtures/chunk_set.recursive_character.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import mmrJson from "@/api/fixtures/retrieval_result.mmr.json"
import searchJson from "@/api/fixtures/output.search.json"
import type { ChunkSet, RetrievalResult } from "@/api/types"

import {
  barWidth,
  componentKeys,
  fmtScore,
  hitIds,
  layoutHits,
  movement,
  rowsFromResult,
  rowsFromSearch,
  scaleMax,
  topKAgreement,
  type SearchOutput,
} from "./hits"

const chunkSet = chunkJson as unknown as ChunkSet
const hybrid = hybridJson as unknown as RetrievalResult
const mmr = mmrJson as unknown as RetrievalResult
const search = searchJson as unknown as SearchOutput

describe("rank movement", () => {
  it("says where a reranked hit was, and nothing when it did not move", () => {
    expect(movement({ rank: 2, prior_rank: 5 })).toEqual({ kind: "up", from: 5, text: "was 5" })
    expect(movement({ rank: 4, prior_rank: 3 })).toEqual({ kind: "down", from: 3, text: "was 3" })
    expect(movement({ rank: 1, prior_rank: 1 })).toEqual({ kind: "none" })
    expect(movement({ rank: 1, prior_rank: null })).toEqual({ kind: "none" })
  })

  it("the real MMR fixture moved its fifth hit to second", () => {
    const rows = rowsFromResult(mmr)
    expect(rows.map((r) => movement(r).kind)).toEqual(["none", "up", "down", "down", "up"])
    expect(movement(rows[1])).toMatchObject({ text: "was 5" })
  })
})

describe("score bars", () => {
  it("dense comes before bm25, and a retriever without components has none", () => {
    expect(componentKeys(rowsFromResult(hybrid))).toEqual(["dense", "bm25"])
    expect(componentKeys([{ ...rowsFromResult(hybrid)[0], component_scores: { rerank: 1, bm25: 2, alpha: 0 } }])).toEqual(["bm25", "alpha", "rerank"])
    expect(componentKeys(rowsFromResult({ ...hybrid, hits: hybrid.hits.map((h) => ({ ...h, component_scores: {} })) }))).toEqual([])
  })

  it("each measure has its own scale; zero, negative and missing values draw nothing", () => {
    expect(scaleMax([0.2, 0.5, undefined, -1])).toBe(0.5)
    expect(barWidth(0.5, 0.5, 48)).toBe(48)
    expect(barWidth(0.25, 0.5, 48)).toBe(24)
    expect(barWidth(0.001, 0.5, 48)).toBe(1)
    expect(barWidth(-0.2, 0.5, 48)).toBe(0)
    expect(barWidth(undefined, 0.5, 48)).toBe(0)
    expect(barWidth(1, 0, 48)).toBe(0)
  })

  it("prints four significant figures, so RRF scores that differ in the fourth digit read apart", () => {
    expect(fmtScore(0.032786)).toBe("0.03279")
    expect(fmtScore(5.131432)).toBe("5.131")
    expect(fmtScore(0)).toBe("0.000")
  })
})

describe("Search output rows", () => {
  it("read the same as the retrieval result they came from", () => {
    const rows = rowsFromSearch(search)
    expect(rows.map((r) => r.chunk_id)).toEqual(rowsFromResult(mmr).map((r) => r.chunk_id))
    expect(rows.map((r) => r.prior_rank)).toEqual(mmr.hits.map((h) => h.prior_rank))
    expect(hitIds(search)).toEqual(hitIds(mmr))
    expect(hitIds({ kind: "chat", payload: {} })).toBeNull()
  })
})

describe("hits on the position spine", () => {
  it("each mark spans exactly its chunk's characters, located by chunk id", () => {
    const rows = rowsFromResult(hybrid)
    const { segments, marks, unplaced } = layoutHits(chunkSet.source_text, chunkSet.chunks, rows)
    expect(unplaced).toEqual([])
    expect(marks.map((m) => m.rank)).toEqual([1, 2, 3, 4, 5, 6])
    for (const m of marks) {
      const chunk = chunkSet.chunks[m.chunkIndex]
      expect(chunk.id).toBe(rows[m.row].chunk_id)
      expect(segments[m.first].start).toBe(chunk.start_char)
      expect(segments[m.last].end).toBe(chunk.end_char)
      // Every segment in between is covered by this mark.
      for (let k = m.first; k <= m.last; k++) expect(segments[k].chunks).toContain(marks.indexOf(m))
    }
    // The segments tile the document exactly once.
    expect(segments.map((s) => chunkSet.source_text.slice(s.start, s.end)).join("")).toBe(chunkSet.source_text)
  })

  it("a hit is placed at its chunk-set offsets: the top hit is the chunk at 1432", () => {
    const { marks, segments } = layoutHits(chunkSet.source_text, chunkSet.chunks, rowsFromResult(hybrid))
    expect(segments[marks[0].first].start).toBe(1432)
    expect(chunkSet.chunks[marks[0].chunkIndex].ordinal).toBe(4)
  })

  it("overlapping hits get different lanes", () => {
    const source = "abcdefghij"
    const chunks = [
      { ...chunkSet.chunks[0], id: "a", start_char: 0, end_char: 6 },
      { ...chunkSet.chunks[0], id: "b", start_char: 4, end_char: 10 },
    ]
    const rows = ["b", "a"].map((id, i) => ({ ...rowsFromResult(hybrid)[0], chunk_id: id, rank: i + 1 }))
    const { marks, segments } = layoutHits(source, chunks, rows)
    expect(marks.map((m) => [m.rank, m.chunkIndex, m.start, m.end])).toEqual([
      [1, 1, 4, 10],
      [2, 0, 0, 6],
    ])
    expect(new Set(marks.map((m) => m.lane)).size).toBe(2)
    expect(segments.map((s) => [s.start, s.end, s.chunks.length])).toEqual([
      [0, 4, 1],
      [4, 6, 2],
      [6, 10, 1],
    ])
  })

  it("a hit from a chunk the set does not have is reported, not guessed", () => {
    const rows = rowsFromResult(hybrid)
    rows[2] = { ...rows[2], chunk_id: "elsewhere" }
    const { marks, unplaced } = layoutHits(chunkSet.source_text, chunkSet.chunks, rows)
    expect(unplaced).toEqual([3])
    expect(marks.map((m) => m.rank)).toEqual([1, 2, 4, 5, 6])
  })
})

describe("top-k agreement", () => {
  it("counts the top k shared with the baseline, in any order", () => {
    expect(topKAgreement(["a", "b", "c", "d", "e"], ["e", "d", "c", "b", "a"])).toEqual({ match: 5, of: 5 })
    expect(topKAgreement(["a", "b", "c", "d", "e"], ["a", "b", "x", "d", "y"])).toEqual({ match: 3, of: 5 })
    expect(topKAgreement(["a", "b", "c", "d", "e", "f"], ["f", "a"])).toEqual({ match: 1, of: 2 })
    expect(topKAgreement([], ["a"])).toEqual({ match: 0, of: 1 })
  })

  it("MMR chooses from hybrid's wider pool: four of its five are in hybrid's top five", () => {
    const ids = (r: RetrievalResult) => r.hits.map((h) => h.chunk.id)
    expect(hybrid.hits.length).toBeGreaterThan(mmr.hits.length)
    expect(topKAgreement(ids(hybrid), ids(mmr))).toEqual({ match: 4, of: 5 })
  })
})
