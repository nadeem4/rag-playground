import type { Chunk, Hit, RetrievalResult } from "@/api/types"

import { assignLanes, projectSpans, type Segment } from "./spans"

/**
 * The pure half of the retrieval inspectors: one row shape for a retriever's
 * hits and for a Search output's rows, the scales their bars read, the rank a
 * reranker moved a hit from, and where each hit sits in the document.
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

/**
 * The largest positive value of one measure across the hits. Each component
 * gets its own scale: a cosine lives in [-1, 1] and a BM25 score is unbounded,
 * so one shared axis would flatten one of them to nothing.
 */
export function scaleMax(values: readonly (number | undefined)[]): number {
  return Math.max(0, ...values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)))
}

/** Bar length in px for `value` on a scale whose maximum is `max`. */
export function barWidth(value: number | undefined, max: number, full: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || max <= 0) return 0
  return Math.max(1, Math.round((value / max) * full))
}

/** Four significant figures: RRF scores differ in the fourth digit. */
export function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(2)
  return v.toPrecision(4)
}

export type Movement = { kind: "none" } | { kind: "up" | "down"; from: number; text: string }

/** Where a reranker moved a hit from: `was 4`. Nothing when it did not move. */
export function movement(row: Pick<HitRowData, "rank" | "prior_rank">): Movement {
  const from = row.prior_rank
  if (from === null || from === undefined || from === row.rank) return { kind: "none" }
  return { kind: from > row.rank ? "up" : "down", from, text: `was ${from}` }
}

export type Badge = { kind: "up" | "down" | "stayed"; text: string }

/** The Ask panel's movement badge: `up from #6`, `down from #2`, `stayed #4`. Null for a hit no reranker saw. */
export function badge(row: Pick<HitRowData, "rank" | "prior_rank">): Badge | null {
  const move = movement(row)
  if (move.kind !== "none") return { kind: move.kind, text: `${move.kind} from #${move.from}` }
  return row.prior_rank === null || row.prior_rank === undefined ? null : { kind: "stayed", text: `stayed #${row.rank}` }
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

/** How many of `ids`' top k are also in `base`'s top k. */
export function topKAgreement(base: readonly string[], ids: readonly string[], k = 5): { match: number; of: number } {
  const want = new Set(base.slice(0, k))
  const top = ids.slice(0, k)
  return { match: top.filter((id) => want.has(id)).length, of: top.length }
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
