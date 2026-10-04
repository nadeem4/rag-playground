import type { Chunk, Hit, RetrievalResult } from "@/api/types"

import { assignLanes, projectSpans, type Segment } from "./spans"

/**
 * The pure half of the retrieval inspectors: one row shape for a retriever's
 * hits and for a Search output's rows, the scales their scores are on, the
 * rank a reranker moved a hit from, the finding line, and where each hit sits
 * in the document.
 */

/** One ranked hit, whichever artifact it came from. */
export interface HitRowData {
  rank: number
  score: number
  prior_rank: number | null
  /** The score before a reranker ran: a reranker that rescored leaves it different from `score`. */
  prior_score: number | null
  retriever: string
  component_scores: Record<string, number>
  chunk_id: string
  /** The ORIGINAL chunk text (or the Search snippet of it), never `embed_text`. */
  text: string
  page_span: [number, number] | null
  /** The chunk's source elements, when the row carries the chunk (a retrieval result). */
  element_ids: string[] | null
  /** The chunk's position in its chunk set: its palette slot when the set is not at hand. */
  ordinal: number | null
  /** The chunk's heading path as one line, `Methods > Survey`, when the chunker gave it one. */
  section: string | null
}

/** A heading path as one line, or null when it is empty. */
export const sectionOf = (path: readonly string[] | null | undefined): string | null => (path?.length ? path.join(" > ") : null)

export function rowsFromResult(r: RetrievalResult): HitRowData[] {
  return r.hits.map((h: Hit) => ({
    rank: h.rank,
    score: h.score,
    prior_rank: h.prior_rank,
    prior_score: h.prior_score ?? null,
    retriever: h.retriever,
    component_scores: h.component_scores ?? {},
    chunk_id: h.chunk.id,
    text: h.chunk.text,
    page_span: h.chunk.page_span,
    element_ids: h.chunk.source_element_ids ?? null,
    ordinal: typeof h.chunk.ordinal === "number" ? h.chunk.ordinal : null,
    section: sectionOf(h.chunk.heading_path),
  }))
}

/**
 * A chunk as a row, for a slip that shows a piece rather than a hit: its rank
 * is its place in the set, and it has no score.
 */
export function rowFromChunk(c: Chunk): HitRowData {
  return {
    rank: c.ordinal + 1,
    score: 0,
    prior_rank: null,
    prior_score: null,
    retriever: "",
    component_scores: {},
    chunk_id: c.id,
    text: c.text,
    page_span: c.page_span,
    element_ids: c.source_element_ids ?? null,
    ordinal: c.ordinal,
    section: sectionOf(c.heading_path),
  }
}

/** Leading markdown heading lines, and the blank lines after them. */
const LEADING_HEADINGS = /^(?:[ \t]*(?:#{1,6}[ \t].*)?(?:\r?\n|$))+/

/**
 * A passage without its leading markdown heading lines, so no raw `##` shows;
 * a heading that is all there is keeps its words and loses its marks.
 */
export function stripHeadingMarks(text: string): string {
  const body = text.replace(LEADING_HEADINGS, "")
  return body.trim() ? body : text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
}

/** A row of the `search` use case's output (plugins/use_case/search.py). */
export interface SearchRow {
  rank: number
  score: number
  component_scores?: Record<string, number>
  prior_rank?: number | null
  prior_score?: number | null
  retriever?: string
  snippet?: string
  chunk_id: string
  page_span?: [number, number] | null
}

export interface SearchOutput {
  kind: string
  payload: { query_id?: string; total_candidates?: number; results?: SearchRow[]; [k: string]: unknown }
}

export function rowsFromSearch(out: SearchOutput): HitRowData[] {
  return (out.payload.results ?? []).map((r) => ({
    rank: r.rank,
    score: r.score,
    prior_rank: r.prior_rank ?? null,
    prior_score: r.prior_score ?? null,
    retriever: r.retriever ?? "",
    component_scores: r.component_scores ?? {},
    chunk_id: r.chunk_id,
    text: r.snippet ?? "",
    page_span: r.page_span ?? null,
    element_ids: null,
    ordinal: null,
    section: null,
  }))
}

/** Hit chunk ids in rank order, from a retrieval result or a Search output. */
export function hitIds(data: unknown): string[] | null {
  if (!data || typeof data !== "object") return null
  if (Array.isArray((data as RetrievalResult).hits)) return rowsFromResult(data as RetrievalResult).map((h) => h.chunk_id)
  const out = data as SearchOutput
  if (out.kind === "search" && Array.isArray(out.payload?.results)) return rowsFromSearch(out).map((h) => h.chunk_id)
  return null
}

const KNOWN = ["dense", "bm25"]

/** Component-score columns, dense and bm25 first, then any others by name. */
export function componentKeys(rows: readonly HitRowData[]): string[] {
  const keys = new Set(rows.flatMap((r) => Object.keys(r.component_scores)))
  return [...KNOWN.filter((k) => keys.has(k)), ...[...keys].filter((k) => !KNOWN.includes(k)).sort()]
}

/** Each score's scale as the panel names it: `RRF 0.0328`, `Dense 0.254`, `Cross-encoder 8.21`. */
const SCALES: Record<string, string> = {
  score: "RRF",
  rrf: "RRF",
  hybrid_rrf: "RRF",
  dense: "Dense",
  bm25: "BM25",
  cross_encoder: "Cross-encoder",
  mmr: "MMR",
  llm_rerank: "LLM",
  llm: "LLM",
}

/** The scale's display name; an unknown key is shown as it is. */
export const scaleName = (key: string): string => SCALES[key] ?? key

/**
 * Which scale a list's `score` is on. A reranker stamps `prior_score` on every
 * hit; only the cross-encoder writes a new score (MMR and the LLM reranker keep
 * the retriever's), so a score that differs from its prior one is the
 * cross-encoder's. Otherwise it is the retriever's own: `hybrid_rrf`, `dense`
 * or `bm25`. With no single retriever named, `score`.
 */
export function scoreKey(rows: readonly HitRowData[]): string {
  if (rows.some((r) => r.prior_score !== null && r.prior_score !== r.score)) return "cross_encoder"
  const retrievers = new Set(rows.map((r) => r.retriever).filter(Boolean))
  return retrievers.size === 1 ? [...retrievers][0] : "score"
}

/**
 * True when a reranker reordered the hits but kept the search's scores (MMR,
 * the LLM reranker): every row has a prior score equal to its score.
 */
export function reorderedOnly(rows: readonly HitRowData[]): boolean {
  return rows.length > 0 && rows.every((r) => r.prior_score !== null && r.prior_score === r.score)
}

/** Four significant figures: RRF scores differ in the fourth digit. */
export function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(2)
  return v.toPrecision(4)
}

export type Movement = { kind: "none" } | { kind: "up" | "down"; from: number }

/** Where a reranker moved a hit from. Nothing when it did not move. */
export function movement(row: Pick<HitRowData, "rank" | "prior_rank">): Movement {
  const from = row.prior_rank
  if (from === null || from === undefined || from === row.rank) return { kind: "none" }
  return { kind: from > row.rank ? "up" : "down", from }
}

/** An English ordinal: `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`. */
export function ordinal(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

/** Which list a slip sits in: one list, the search side or the reranked side of the comparison, or below the kept ones. */
export type SlipSide = "single" | "search" | "reranked" | "notKept"

/** A run of the finding line: `place` is the ordinal, `strong` the movement of a piece that rose, `mono` a score. */
export interface FindingPart {
  text: string
  place?: boolean
  strong?: boolean
  mono?: boolean
}

/**
 * The finding line, in the tool's voice: `1st` in one list; `1st in search,
 * RRF 0.03279` on the search side; `2nd, moved up from 4th`, `3rd, stayed in
 * place` or `4th, moved down from 2nd` on the reranked side. A piece the
 * reranker did not keep says why: past the keep limit, `Not kept. It was 6th
 * in search and the keep limit is 5.`; from inside it, the reranker's choice,
 * `Not kept. It was 5th in search, but MMR chose others for variety.`
 * `reranker` is the reranker's transform key. `withScore` false leaves the
 * search side's score out (`1st in search`), for a compact slip that shows it
 * on its meta line.
 */
export function findingLine(
  row: Pick<HitRowData, "rank" | "prior_rank" | "score">,
  side: SlipSide,
  scaleKey: string,
  keepLimit?: number,
  reranker?: string,
  withScore = true,
): FindingPart[] {
  if (side === "notKept") {
    const searchRank = row.prior_rank ?? row.rank
    const was = `Not kept. It was ${ordinal(searchRank)} in search`
    if (keepLimit === undefined) return [{ text: `${was}.` }]
    if (searchRank > keepLimit) return [{ text: `${was} and the keep limit is ${keepLimit}.` }]
    return [{ text: `${was}, but ${chose(reranker)}` }]
  }
  const place: FindingPart = { text: ordinal(row.rank), place: true }
  if (side === "search") return withScore ? [place, { text: ` in search, ${scaleName(scaleKey)} ` }, { text: fmtScore(row.score), mono: true }] : [place, { text: " in search" }]
  if (side === "single" || row.prior_rank == null) return [place]
  const move = movement(row)
  if (move.kind === "none") return [place, { text: ", stayed in place" }]
  if (move.kind === "up") return [place, { text: ", " }, { text: `moved up from ${ordinal(move.from)}`, strong: true }]
  return [place, { text: `, moved down from ${ordinal(move.from)}` }]
}

/** Why a reranker left out a piece that was inside its keep limit. */
function chose(reranker: string | undefined): string {
  if (!reranker) return "the reranker chose others."
  if (reranker === "mmr") return "MMR chose others for variety."
  if (reranker === "cross_encoder") return "Cross-encoder ranked others higher."
  return `${scaleName(reranker)} chose others.`
}

export function pages(span: [number, number] | null): string | null {
  if (!span) return null
  return span[0] === span[1] ? `p. ${span[0]}` : `pp. ${span[0]}-${span[1]}`
}

// ------------------------------------------------------------- the spine --

/** One hit placed on the document. */
export interface HitMark {
  /** Index into the rows. */
  row: number
  rank: number
  /** Index of the chunk in the chunk set: its palette slot in every view. */
  chunkIndex: number
  start: number
  end: number
  /** Segment range the mark spans, for measuring against the rendered text. */
  first: number
  last: number
  lane: number
}

export interface HitLayout {
  /** Maximal segments of constant hit coverage; `chunks` index into `marks`. */
  segments: Segment[]
  marks: HitMark[]
  /** Ranks of hits whose chunk is not in this chunk set (another document, or a stale set). */
  unplaced: number[]
}

/**
 * Put each hit on the document it was cut from. A hit is located by its chunk
 * id in the upstream chunk set, so its offsets are the chunker's own
 * `start_char` / `end_char` into `source_text`; nothing is re-derived from the
 * text. The segments are then measured in the browser like every other spine.
 */
export function layoutHits(source: string, chunks: readonly Chunk[], rows: readonly HitRowData[]): HitLayout {
  const byId = new Map(chunks.map((c, i) => [c.id, i]))
  const placed: { row: number; chunkIndex: number; start: number; end: number }[] = []
  const unplaced: number[] = []
  rows.forEach((r, i) => {
    const ci = byId.get(r.chunk_id)
    const c = ci === undefined ? undefined : chunks[ci]
    if (!c || c.end_char <= c.start_char || c.start_char >= source.length) unplaced.push(r.rank)
    else placed.push({ row: i, chunkIndex: ci!, start: c.start_char, end: Math.min(c.end_char, source.length) })
  })
  const spans = placed.map((p, k) => ({ id: `h${k}`, start_char: p.start, end_char: p.end }))
  const segments = projectSpans(source, spans)
  const lanes = assignLanes(spans)
  const marks = placed.map((p, k): HitMark => {
    let first = -1
    let last = -1
    segments.forEach((s, j) => {
      if (s.chunks.includes(k)) {
        if (first === -1) first = j
        last = j
      }
    })
    return { ...p, rank: rows[p.row].rank, first, last, lane: lanes[k] }
  })
  return { segments, marks, unplaced }
}

// ------------------------------------------------------------- agreement --

/** What changed between two ranked lists of chunk ids, read at their top k. Places are 1-based. */
export type ListChange =
  | { kind: "same"; of: number }
  | { kind: "swap"; places: [number, number]; of: number }
  | { kind: "moved"; count: number; of: number }
  | { kind: "shorter"; returned: number; of: number; shared: number; samePlaces: number }
  | { kind: "different"; shared: number; of: number; top: number }

/**
 * Compare `ids` with the baseline `base`, both cut at their top k: the same
 * pieces in the same order, two places swapped, the same pieces with more
 * places changed, a shorter list, or a different set. A swap is said as a
 * swap and a shorter list as shorter, which a plain overlap count hides.
 */
export function compareLists(base: readonly string[], ids: readonly string[], k = 5): ListChange {
  const a = base.slice(0, k)
  const b = ids.slice(0, k)
  const inBase = new Set(a)
  const shared = b.filter((id) => inBase.has(id)).length
  if (b.length < a.length) return { kind: "shorter", returned: b.length, of: a.length, shared, samePlaces: b.filter((id, i) => a[i] === id).length }
  if (b.length > a.length || shared < b.length) return { kind: "different", shared, of: b.length, top: a.length }
  const moved = a.flatMap((id, i) => (b[i] === id ? [] : [i]))
  if (moved.length === 0) return { kind: "same", of: a.length }
  if (moved.length === 2) return { kind: "swap", places: [moved[0] + 1, moved[1] + 1], of: a.length }
  return { kind: "moved", count: moved.length, of: a.length }
}

const pieces = (n: number) => `${n} ${n === 1 ? "piece" : "pieces"}`

/** A `ListChange` in a sentence, read against the baseline's plain name. */
export function agreementText(c: ListChange, baseName: string): string {
  switch (c.kind) {
    case "same":
      return `Same ${pieces(c.of)}, in the same order.`
    case "swap":
      return `Same ${pieces(c.of)}. The ${ordinal(c.places[0])} and ${ordinal(c.places[1])} swap places.`
    case "moved":
      return `Same ${pieces(c.of)}. ${c.count} of them are in a different place.`
    case "different":
      return `${c.shared} of the ${pieces(c.of)} ${c.shared === 1 ? "is" : "are"} also in the top ${c.top} of ${baseName}.`
    case "shorter": {
      const head = c.returned === 0 ? `Returned no pieces, not ${c.of}.` : `Returned ${pieces(c.returned)}, not ${c.of}.`
      if (c.returned === 0) return head
      const all = c.returned === 1 ? "It" : c.returned === 2 ? "Both" : `All ${c.returned}`
      const top = `the top ${c.of} of ${baseName}`
      if (c.shared === c.returned && c.samePlaces === c.returned) {
        return `${head} ${all} ${c.returned === 1 ? "sits where" : "sit where"} ${baseName} ${c.returned === 1 ? "puts it" : "puts them"}.`
      }
      if (c.shared === c.returned) {
        const verb = c.returned === 1 ? "is" : "are"
        if (c.samePlaces === 0) return `${head} ${all} ${verb} in ${top}, ${c.returned === 1 ? "in another place" : "in other places"}.`
        return `${head} ${all} ${verb} in ${top}, and ${c.samePlaces} ${c.samePlaces === 1 ? "sits" : "sit"} in the same place.`
      }
      if (c.shared === 0) return `${head} None of them is in ${top}.`
      return `${head} ${c.shared} of them ${c.shared === 1 ? "is" : "are"} in ${top}.`
    }
  }
}

/**
 * What "Show in PDF" needs for a hit: its source elements, page span and
 * palette slot. The chunk set is preferred (a Search row carries only the
 * chunk id); the row's own chunk fields are the fallback.
 */
export function pdfTarget(
  row: HitRowData,
  chunks: readonly Chunk[] | undefined,
): { elementIds: string[]; pageSpan: [number, number] | null; chunkIndex: number | null } | null {
  const i = chunks ? chunks.findIndex((c) => c.id === row.chunk_id) : -1
  if (chunks && i !== -1) return { elementIds: chunks[i].source_element_ids, pageSpan: chunks[i].page_span, chunkIndex: i }
  if (row.element_ids) return { elementIds: row.element_ids, pageSpan: row.page_span, chunkIndex: row.ordinal }
  return null
}
