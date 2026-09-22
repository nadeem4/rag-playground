import type { Chunk, ChunkSet } from "@/api/types"

/**
 * What a real chunk set shows a learner: how many chunks, how much text is
 * repeated, and where one sentence landed. Pure, computed from offsets into
 * the chunk set's `source_text`, never from a simulation.
 */

/**
 * Where `needle` sits in `text`, as raw offsets, treating every run of
 * whitespace as one space. A parser keeps the PDF's line breaks inside a
 * sentence, so an exact search would miss it.
 */
export function findLoose(text: string, needle: string): [number, number] | null {
  const map: number[] = []
  let flat = ""
  let space = false
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!space && flat.length) {
        flat += " "
        map.push(i)
      }
      space = true
    } else {
      flat += text[i]
      map.push(i)
      space = false
    }
  }
  const want = needle.trim().replace(/\s+/g, " ")
  const at = want ? flat.indexOf(want) : -1
  if (at < 0) return null
  return [map[at], map[at + want.length - 1] + 1]
}

export interface ChunkView {
  chunk: Chunk
  /** Characters at the start of this chunk that the chunk before also holds. */
  repeat: number
  /** The answer sentence's part inside this chunk, relative to its start. */
  answer: [number, number] | null
  /** The answer is cut at this chunk's end and continues in this (0-based) chunk. */
  continuesIn: number | null
}

export interface ChunkAnalysis {
  count: number
  chunks: ChunkView[]
  /** Characters stored across all chunks. */
  stored: number
  /** Characters stored more than once, because of overlap. */
  repeated: number
  /** `repeated / stored`, as a rounded percentage. */
  sharePct: number
  /** Offsets of the answer sentence in the source text. */
  answerAt: [number, number] | null
  /** The first chunk (0-based) that holds the whole answer sentence. */
  whole: number | null
  /** Every chunk (0-based) that holds part of it. */
  touching: number[]
}

export function analyzeChunks(set: ChunkSet, answer?: string): ChunkAnalysis {
  const sorted = [...set.chunks].sort((a, b) => a.start_char - b.start_char || a.end_char - b.end_char)
  const at = answer ? findLoose(set.source_text, answer) : null
  const touching = at ? sorted.flatMap((c, i) => (c.start_char < at[1] && c.end_char > at[0] ? [i] : [])) : []
  const chunks = sorted.map((c, i): ChunkView => {
    const prev = sorted[i - 1]
    const repeat = prev ? Math.max(0, Math.min(prev.end_char, c.end_char) - c.start_char) : 0
    const inside = at && c.start_char < at[1] && c.end_char > at[0]
    const next = touching.find((t) => t > i)
    return {
      chunk: c,
      repeat,
      answer: inside ? [Math.max(at[0], c.start_char) - c.start_char, Math.min(at[1], c.end_char) - c.start_char] : null,
      continuesIn: inside && c.end_char < at[1] && next !== undefined ? next : null,
    }
  })
  const stored = sorted.reduce((t, c) => t + (c.end_char - c.start_char), 0)
  const repeated = chunks.reduce((t, c) => t + c.repeat, 0)
  const whole = at ? sorted.findIndex((c) => c.start_char <= at[0] && c.end_char >= at[1]) : -1
  return {
    count: sorted.length,
    chunks,
    stored,
    repeated,
    sharePct: stored ? Math.round((100 * repeated) / stored) : 0,
    answerAt: at,
    whole: whole >= 0 ? whole : null,
    touching,
  }
}

/** "What you are seeing", in full sentences, from a real chunk set. */
export function seeingLines(a: ChunkAnalysis): string[] {
  const lines = [`The document became ${a.count} ${a.count === 1 ? "chunk" : "chunks"}.`]
  if (a.repeated === 0) {
    lines.push("No text is repeated between chunks, so nothing is stored twice.")
  } else {
    const share = a.sharePct === 0 ? "Less than 1%" : `${a.sharePct}%`
    lines.push(`${share} of the text in these chunks is repeated from the chunk before. Repeated text is stored and searched more than once.`)
  }
  return lines
}
