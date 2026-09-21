import { describe, expect, it } from "vitest"

import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import markdownJson from "@/api/fixtures/chunk_set.markdown_header.json"
import type { ChunkSet } from "@/api/types"

import { assignLanes, chunkSlot, median, overlapPairs, p95, projectSpans, type SpanChunk } from "./spans"

const recursive = recursiveJson as unknown as ChunkSet
const markdown = markdownJson as unknown as ChunkSet

const c = (id: string, start_char: number, end_char: number): SpanChunk => ({ id, start_char, end_char })

/** Deterministic PRNG so a failing case can be replayed. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** The two properties that make off-by-one errors loud. */
function checkProperties(source: string, chunks: SpanChunk[]) {
  const segs = projectSpans(source, chunks)
  // 1. The segments tile the source exactly, in order, with no empty segment.
  expect(segs.map((s) => source.slice(s.start, s.end)).join("")).toBe(source)
  let at = 0
  for (const s of segs) {
    expect(s.start).toBe(at)
    expect(s.end).toBeGreaterThan(s.start)
    at = s.end
  }
  // 2. Every chunk's (clamped) range is exactly the union of the segments listing it.
  chunks.forEach((ch, i) => {
    const start = Math.max(0, Math.min(ch.start_char, source.length))
    const end = Math.max(start, Math.min(ch.end_char, source.length))
    const mine = segs.filter((s) => s.chunks.includes(i))
    const covered = mine.reduce((n, s) => n + (s.end - s.start), 0)
    expect(covered, `chunk ${i} length`).toBe(end - start)
    if (end > start) {
      expect(mine[0].start).toBe(start)
      expect(mine[mine.length - 1].end).toBe(end)
      for (let k = 1; k < mine.length; k++) expect(mine[k].start).toBe(mine[k - 1].end) // contiguous
    }
    for (const s of mine) expect(s.chunkIds).toContain(ch.id)
  })
  // 3. Maximal: no two neighbours carry the same covering set.
  for (let k = 1; k < segs.length; k++) {
    expect(segs[k].chunks.join(",")).not.toBe(segs[k - 1].chunks.join(","))
  }
  return segs
}

describe("projectSpans", () => {
  it("returns nothing for an empty source", () => {
    expect(projectSpans("", [])).toEqual([])
    expect(projectSpans("", [c("a", 0, 0)])).toEqual([])
  })

  it("returns one uncovered segment for an empty chunk set", () => {
    expect(projectSpans("hello", [])).toEqual([{ start: 0, end: 5, chunkIds: [], chunks: [] }])
  })

  it("marks gaps, single coverage and overlap", () => {
    const src = "abcdefghij"
    const segs = checkProperties(src, [c("a", 1, 4), c("b", 3, 6), c("c", 8, 10)])
    expect(segs.map((s) => [s.start, s.end, s.chunkIds.join("+")])).toEqual([
      [0, 1, ""],
      [1, 3, "a"],
      [3, 4, "a+b"],
      [4, 6, "b"],
      [6, 8, ""],
      [8, 10, "c"],
    ])
  })

  it("skips zero-length chunks without splitting a segment", () => {
    const segs = checkProperties("abcdef", [c("a", 0, 6), c("z", 3, 3)])
    expect(segs).toHaveLength(1)
    expect(segs[0].chunkIds).toEqual(["a"])
  })

  it("handles adjacent chunks, identical chunks and triple overlap", () => {
    checkProperties("abcdefgh", [c("a", 0, 4), c("b", 4, 8)])
    const same = checkProperties("abcd", [c("a", 0, 4), c("b", 0, 4)])
    expect(same).toEqual([{ start: 0, end: 4, chunkIds: ["a", "b"], chunks: [0, 1] }])
    const triple = checkProperties("abcdefgh", [c("a", 0, 6), c("b", 2, 8), c("c", 3, 5)])
    expect(triple.find((s) => s.chunks.length === 3)).toMatchObject({ start: 3, end: 5 })
  })

  it("clamps out-of-range and inverted offsets", () => {
    checkProperties("abc", [c("a", -5, 2), c("b", 2, 99), c("c", 2, 1)])
  })

  it("holds both properties on 500 random chunk sets", () => {
    const rand = lcg(20260920)
    for (let run = 0; run < 500; run++) {
      const len = Math.floor(rand() * 60)
      const source = Array.from({ length: len }, () => "ab \n"[Math.floor(rand() * 4)]).join("")
      const n = Math.floor(rand() * 8)
      const chunks = Array.from({ length: n }, (_, i) => {
        const a = Math.floor(rand() * (len + 4)) - 2
        const b = rand() < 0.15 ? a : a + Math.floor(rand() * (len / 2 + 2))
        return c(`k${i}`, a, b)
      })
      checkProperties(source, chunks)
    }
  })

  it("holds on every real chunk set and reproduces chunk.text from the offsets", () => {
    for (const set of [recursive, markdown]) {
      checkProperties(set.source_text, set.chunks)
      for (const ch of set.chunks) expect(set.source_text.slice(ch.start_char, ch.end_char)).toBe(ch.text)
    }
  })

  it("finds the 3 overlapping adjacent pairs in the recursive fixture", () => {
    const segs = projectSpans(recursive.source_text, recursive.chunks)
    const overlaps = segs.filter((s) => s.chunks.length >= 2)
    expect(overlaps).toHaveLength(3)
    expect(overlaps.map((s) => s.chunks)).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
    ])
    // chunk 2 is 745-1134 and chunk 3 starts at 1112: the overlap is exactly that span.
    expect(overlaps[0]).toMatchObject({ start: 1112, end: 1134 })
    expect(overlapPairs(segs)).toHaveLength(3)
    // The first two boundaries fall on paragraph breaks: a clean cut, no overlap.
    expect(segs.filter((s) => s.chunks.length === 0).map((s) => [s.start, s.end])).toEqual([
      [366, 368],
      [743, 745],
    ])
  })

  it("finds the uncovered separators in the markdown_header fixture", () => {
    const segs = projectSpans(markdown.source_text, markdown.chunks)
    const gaps = segs.filter((s) => s.chunks.length === 0)
    expect(gaps.map((s) => [s.start, s.end])).toEqual([
      [464, 466],
      [774, 776],
      [1134, 1136],
      [1759, 1761],
    ])
    expect(overlapPairs(segs)).toHaveLength(0)
  })
})

describe("chunkSlot", () => {
  it("cycles the 8 hues in slot order past the eighth chunk", () => {
    expect([0, 1, 7, 8, 9, 15, 16].map(chunkSlot)).toEqual([1, 2, 8, 1, 2, 8, 1])
  })
})

describe("assignLanes", () => {
  it("puts overlapping chunks in different lanes and reuses freed lanes", () => {
    expect(assignLanes([c("a", 0, 10), c("b", 5, 15), c("c", 12, 20), c("d", 16, 30)])).toEqual([0, 1, 0, 1])
    expect(assignLanes([c("a", 0, 10), c("b", 10, 20)])).toEqual([0, 0])
    expect(assignLanes([c("a", 0, 10), c("b", 1, 9), c("c", 2, 8)])).toEqual([0, 1, 2])
  })
})

describe("median and p95", () => {
  it("uses the midpoint for median and nearest rank for p95", () => {
    expect(median([])).toBeNull()
    expect(p95([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toBe(19)
    expect(p95([69, 69, 75, 69, 73, 75, 37])).toBe(75)
  })
})
