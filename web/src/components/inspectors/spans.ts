/**
 * Span projection: turn `(source_text, chunks)` into maximal segments, each
 * with a constant set of covering chunks. The chunk-boundary view renders one
 * inline span per segment, so every boundary, gap and overlap is visible.
 *
 * Offsets are the engine's `start_char` / `end_char`, which satisfy
 * `source_text.slice(start, end) === chunk.text` by construction. Nothing here
 * re-derives text positions any other way.
 */

/** The only chunk fields the projection reads. */
export interface SpanChunk {
  id: string
  start_char: number
  end_char: number
}

export interface Segment {
  start: number
  end: number
  /** Ids of the chunks covering this segment, in chunk-array order. */
  chunkIds: string[]
  /** Indices into the chunk array, same order as `chunkIds`. */
  chunks: number[]
}

/** Number of hues in the categorical chunk palette (tokens.css). */
export const HUE_COUNT = 8

/** Palette slot (1..8) for the i-th chunk: hues repeat in slot order. */
export function chunkSlot(index: number): number {
  return (index % HUE_COUNT) + 1
}

function clampRange(ch: SpanChunk, len: number): [number, number] {
  const start = Math.max(0, Math.min(ch.start_char, len))
  const end = Math.max(start, Math.min(ch.end_char, len))
  return [start, end]
}

export function projectSpans(source: string, chunks: readonly SpanChunk[]): Segment[] {
  const len = source.length
  if (len === 0) return []

  // Sweep over boundary points. Zero-length chunks never enter the active set.
  const opens = new Map<number, number[]>()
  const closes = new Map<number, number[]>()
  const points = new Set<number>([0, len])
  chunks.forEach((ch, i) => {
    const [start, end] = clampRange(ch, len)
    if (end <= start) return
    points.add(start)
    points.add(end)
    opens.set(start, [...(opens.get(start) ?? []), i])
    closes.set(end, [...(closes.get(end) ?? []), i])
  })
  const sorted = [...points].sort((a, b) => a - b)

  const active = new Set<number>()
  const out: Segment[] = []
  for (let k = 0; k < sorted.length - 1; k++) {
    const at = sorted[k]
    for (const i of closes.get(at) ?? []) active.delete(i)
    for (const i of opens.get(at) ?? []) active.add(i)
    const idx = [...active].sort((a, b) => a - b)
    const prev = out[out.length - 1]
    if (prev && prev.chunks.join(",") === idx.join(",")) {
      prev.end = sorted[k + 1] // same covering set: extend, keep segments maximal
    } else {
      out.push({ start: at, end: sorted[k + 1], chunkIds: idx.map((i) => chunks[i].id), chunks: idx })
    }
  }
  return out
}

/** Distinct chunk pairs that share at least one character. */
export function overlapPairs(segments: readonly Segment[]): [number, number][] {
  const seen = new Set<string>()
  const pairs: [number, number][] = []
  for (const s of segments) {
    for (let a = 0; a < s.chunks.length; a++) {
      for (let b = a + 1; b < s.chunks.length; b++) {
        const key = `${s.chunks[a]}:${s.chunks[b]}`
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push([s.chunks[a], s.chunks[b]])
      }
    }
  }
  return pairs
}

/**
 * Greedy interval lanes for the spine: overlapping chunks get different
 * lanes, so an overlap shows as two bands side by side, never one hiding the other.
 */
export function assignLanes(chunks: readonly SpanChunk[]): number[] {
  const order = chunks.map((_, i) => i).sort((a, b) => chunks[a].start_char - chunks[b].start_char || a - b)
  const laneEnds: number[] = []
  const lanes = new Array<number>(chunks.length).fill(0)
  for (const i of order) {
    const { start_char: start, end_char: end } = chunks[i]
    let lane = laneEnds.findIndex((e) => e <= start)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = Math.max(end, start)
    lanes[i] = lane
  }
  return lanes
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Nearest-rank 95th percentile: a value that actually occurs in the data. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]
}
