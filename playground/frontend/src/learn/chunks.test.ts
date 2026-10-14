import { describe, expect, it } from "vitest"

import type { Chunk, ChunkSet } from "@/api/types"

import { analyzeChunks, findLoose, seeingLines } from "./chunks"

function set(source: string, spans: [number, number][]): ChunkSet {
  const chunks = spans.map(
    ([s, e], i): Chunk => ({
      id: `c${i}`,
      text: source.slice(s, e),
      embed_text: null,
      start_char: s,
      end_char: e,
      token_count: 0,
      kind: "chunk",
      parent_id: null,
      level: 0,
      ordinal: i,
      doc_id: "d",
      heading_path: [],
      source_element_ids: [],
      page_span: null,
      metadata: {},
    }),
  )
  return { chunks, doc_id: "d", source_text: source, chunker_meta: {} }
}

//            0         1         2         3         4
//            0123456789012345678901234567890123456789012345
const DOC = "Intro line. The answer is\nhere in full. Outro."
const ANSWER = "The answer is here in full."

describe("findLoose", () => {
  it("finds a sentence across a line break, as offsets into the raw text", () => {
    const at = findLoose(DOC, ANSWER)!
    expect(DOC.slice(at[0], at[1])).toBe("The answer is\nhere in full.")
  })

  it("is null when the sentence is not there", () => {
    expect(findLoose(DOC, "Not in it.")).toBeNull()
  })
})

describe("analyzeChunks", () => {
  it("counts chunks and finds the one that holds the answer whole", () => {
    const a = analyzeChunks(set(DOC, [[0, 11], [12, 39], [40, 46]]), ANSWER)
    expect(a.count).toBe(3)
    expect(a.whole).toBe(1)
    expect(a.touching).toEqual([1])
    expect(a.chunks[1].answer).toEqual([0, 27])
    expect(a.repeated).toBe(0)
    expect(a.sharePct).toBe(0)
  })

  it("reports a cut answer, where it is cut and which chunk it continues in", () => {
    const a = analyzeChunks(set(DOC, [[0, 25], [25, 46]]), ANSWER)
    expect(a.whole).toBeNull()
    expect(a.touching).toEqual([0, 1])
    expect(a.chunks[0].continuesIn).toBe(1)
    expect(a.chunks[1].continuesIn).toBeNull()
    expect(a.chunks[0].answer).toEqual([12, 25])
    expect(a.chunks[1].answer).toEqual([0, 14])
  })

  it("measures repeated text: characters each chunk shares with the one before", () => {
    // Chunk 2 starts 10 characters before chunk 1 ends.
    const a = analyzeChunks(set(DOC, [[0, 30], [20, 46]]), ANSWER)
    expect(a.chunks[0].repeat).toBe(0)
    expect(a.chunks[1].repeat).toBe(10)
    expect(a.repeated).toBe(10)
    expect(a.stored).toBe(56)
    expect(a.sharePct).toBe(18)
  })

  it("works without an answer sentence", () => {
    const a = analyzeChunks(set(DOC, [[0, 46]]))
    expect(a.whole).toBeNull()
    expect(a.touching).toEqual([])
    expect(a.chunks[0].answer).toBeNull()
  })

  it("orders chunks by where they start", () => {
    const a = analyzeChunks(set(DOC, [[25, 46], [0, 30]]))
    expect(a.chunks.map((c) => c.chunk.start_char)).toEqual([0, 25])
    expect(a.chunks[1].repeat).toBe(5)
  })
})

describe("seeingLines", () => {
  it("says how many chunks there are and that nothing repeats", () => {
    expect(seeingLines(analyzeChunks(set(DOC, [[0, 11], [12, 46]])))).toEqual([
      "The document became 2 chunks.",
      "No text is repeated between chunks, so nothing is stored twice.",
    ])
  })

  it("gives the share of repeated text", () => {
    expect(seeingLines(analyzeChunks(set(DOC, [[0, 30], [20, 46]])))).toEqual([
      "The document became 2 chunks.",
      "18% of the text in these chunks is repeated from the chunk before. Repeated text is stored and searched more than once.",
    ])
  })

  it("uses the singular for one chunk, and never rounds a real repeat down to zero", () => {
    expect(seeingLines(analyzeChunks(set(DOC, [[0, 46]])))[0]).toBe("The document became 1 chunk.")
    const long = "x".repeat(1000)
    expect(seeingLines(analyzeChunks(set(long, [[0, 600], [599, 1000]])))[1]).toMatch(/^Less than 1% of the text/)
  })

  it("has no em-dashes", () => {
    const lines = seeingLines(analyzeChunks(set(DOC, [[0, 30], [20, 46]])))
    expect(lines.join(" ")).not.toMatch(/[—–]/)
  })
})
