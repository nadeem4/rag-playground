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
  retriever: string
  component_scores: Record<string, number>
  chunk_id: string
  /** The ORIGINAL chunk text (or the Search snippet of it), never `embed_text`. */
  text: string
  page_span: [number, number] | null
}

export function rowsFromResult(r: RetrievalResult): HitRowData[] {
  return r.hits.map((h: Hit) => ({
    rank: h.rank,
    score: h.score,
    prior_rank: h.prior_rank,
    retriever: h.retriever,
    component_scores: h.component_scores ?? {},
    chunk_id: h.chunk.id,
    text: h.chunk.text,
    page_span: h.chunk.page_span,
  }))
}

/** A row of the `search` use case's output (plugins/use_case/search.py). */
export interface SearchRow {
  rank: number
  score: number
  component_scores?: Record<string, number>
  prior_rank?: number | null
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
    retriever: r.retriever ?? "",
    component_scores: r.component_scores ?? {},
    chunk_id: r.chunk_id,
    text: r.snippet ?? "",
    page_span: r.page_span ?? null,
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
