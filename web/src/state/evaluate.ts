import type { EvalOutput, EvalPayload, GraphNode, Registry, SampleQuestion, Stage, Variant } from "@/api/types"
import type { HitRowData } from "@/components/inspectors/hits"

import { columnOrder, setConfig, setTransform, titleFor, type PipelineGraph } from "./graph"
import type { Question } from "./goldSet"

/**
 * The arithmetic behind the Evaluate screen, kept pure so it is testable
 * without a browser.
 *
 * An evaluation is the pipeline you already built, with its use case swapped
 * for `eval`, swept over the question set. One variant per question, each
 * setting the question and the sentence that answers it together, because the
 * eval step fails a question that carries no gold answer.
 */

export type { EvalOutput, EvalPayload, SampleQuestion }

export function isEvalOutput(data: unknown): data is EvalOutput {
  const out = data as EvalOutput | null
  return typeof out === "object" && out !== null && out.kind === "eval" && typeof out.payload === "object" && out.payload !== null
}

export const EVAL_TRANSFORM = "eval"

/** A graph can be evaluated only when something retrieves. */
export function hasRetriever(g: PipelineGraph): boolean {
  return g.nodes.some((n) => n.stage === "retrieve")
}

/**
 * The stored pipeline with its use case swapped for `eval` at this `top_k`.
 * Every step above the use case keeps its transform and its config, so a
 * second evaluation after one setting change comes from the cache. Null when
 * the graph has no use case, or the server has no eval step.
 */
export function evalGraph(g: PipelineGraph, registry: Registry, topK: number): PipelineGraph | null {
  const use = g.nodes.find((n) => n.stage === "use_case")
  if (!use || !registry.use_case?.[EVAL_TRANSFORM]) return null
  const swapped = setTransform(g, use.id, EVAL_TRANSFORM, registry)
  const node = swapped.nodes.find((n) => n.id === use.id)!
  return setConfig(swapped, use.id, { ...node.config, top_k: topK })
}

/**
 * One variant per question, each setting the question and its gold passages.
 * Both fields go out: `gold_answers` is the list a question may have several of
 * (plan I-32), and `gold_answer` still carries the first, so a server that has
 * only the older field still scores the run.
 */
export function questionVariants(query: Pick<GraphNode, "transform" | "config">, questions: readonly Question[]): Variant[] {
  return questions.map((q) => ({
    transform: query.transform,
    config: { ...query.config, text: q.question, gold_answer: q.gold_answers[0] ?? "", gold_answers: q.gold_answers },
  }))
}

/** The steps an evaluation is a verdict on, top to bottom. */
const DESCRIBED: Stage[] = ["parse", "clean", "chunk", "index", "retrieve", "rerank"]

export function pipelineSteps(g: PipelineGraph): { label: string; transform: string }[] {
  return columnOrder(g)
    .filter((n) => DESCRIBED.includes(n.stage))
    .map((n) => ({ label: titleFor(n), transform: n.transform }))
}

// ------------------------------------------------------------- the summary --

export interface EvalSummary {
  /** Questions whose answer was in the top k. */
  hits: number
  /** Questions asked, finished or not. */
  total: number
  /** Mean rank of the first containing hit, over the questions that hit. */
  averageRank: number | null
}

export function summarize(payloads: readonly (EvalPayload | undefined)[]): EvalSummary {
  const hits = payloads.filter((p): p is EvalPayload => p !== undefined && p.hit)
  const ranks = hits.map((p) => p.rank).filter((r): r is number => typeof r === "number")
  return {
    hits: hits.length,
    total: payloads.length,
    averageRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
  }
}

/** `9 of 10 found the answer, was 7 of 10`. */
export function summaryLine(now: EvalSummary, before?: EvalSummary | null): string {
  const head = `${now.hits} of ${now.total} found the answer`
  return before ? `${head}, was ${before.hits} of ${before.total}` : head
}

// ------------------------------------------------------------- the metrics --

/** How many questions found the answer at each rank. */
export interface Spread {
  rank: number
  count: number
}

/**
 * Everything the page can say about a run, computed from the per-question
 * payloads. `hitRate` is the headline; the rest is there for whoever wants it.
 * Every rate is over the questions that have finished, so a half-done run reads
 * as what it has, not as a pile of misses.
 */
export interface EvalMetrics {
  /** Questions asked, finished or not. */
  total: number
  /** Questions that have a payload. */
  scored: number
  hits: number
  /** Hit rate at k: hits over scored. Null before anything finishes. */
  hitRate: number | null
  /** Mean reciprocal rank over the scored questions. A miss contributes zero. */
  mrr: number | null
  /** Gold passages the questions have, over the payloads that count them. */
  goldsTotal: number
  goldsFound: number
  /** Some question has more than one gold passage, so recall says something. */
  multiGold: boolean
  /** Recall at k, or null when every question has one gold passage. */
  recall: number | null
  meanRank: number | null
  medianRank: number | null
  spread: Spread[]
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function metrics(payloads: readonly (EvalPayload | undefined)[]): EvalMetrics {
  const scored = payloads.filter((p): p is EvalPayload => p !== undefined)
  const ranks = scored.filter((p) => p.hit).map((p) => p.rank).filter((r): r is number => typeof r === "number")
  const sorted = [...ranks].sort((a, b) => a - b)

  let goldsTotal = 0
  let goldsFound = 0
  let multiGold = false
  for (const p of scored) {
    if (typeof p.golds_total !== "number") continue
    goldsTotal += p.golds_total
    goldsFound += p.golds_found ?? 0
    if (p.golds_total > 1) multiGold = true
  }

  const spread: Spread[] = []
  for (const r of sorted) {
    const last = spread[spread.length - 1]
    if (last && last.rank === r) last.count += 1
    else spread.push({ rank: r, count: 1 })
  }

  return {
    total: payloads.length,
    scored: scored.length,
    hits: scored.filter((p) => p.hit).length,
    hitRate: scored.length ? scored.filter((p) => p.hit).length / scored.length : null,
    mrr: scored.length ? scored.reduce((sum, p) => sum + (p.hit && p.rank ? 1 / p.rank : 0), 0) / scored.length : null,
    goldsTotal,
    goldsFound,
    multiGold,
    recall: multiGold && goldsTotal > 0 ? goldsFound / goldsTotal : null,
    meanRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
    medianRank: median(sorted),
    spread,
  }
}

export interface TagMetrics {
  tag: string
  metrics: EvalMetrics
}

/** The same numbers per tag. Empty when no question carries one. */
export function metricsByTag(items: readonly { tags: readonly string[]; payload?: EvalPayload }[]): TagMetrics[] {
  const byTag = new Map<string, (EvalPayload | undefined)[]>()
  for (const item of items) {
    for (const tag of item.tags) {
      const list = byTag.get(tag) ?? []
      list.push(item.payload)
      byTag.set(tag, list)
    }
  }
  return [...byTag.keys()].sort().map((tag) => ({ tag, metrics: metrics(byTag.get(tag)!) }))
}

/** A rate as a whole percentage. Null stays null, so the page can leave it out. */
export function percent(x: number | null): string | null {
  return x === null ? null : `${Math.round(x * 100)}%`
}

/** The finished evaluation the next one is compared against. */
export interface PreviousEvaluation {
  byId: Record<string, EvalPayload>
  summary: EvalSummary
}

const PREVIOUS_KEY = "rag-playground:evaluation:previous"

/**
 * The previous evaluation is kept in session storage rather than React state,
 * because changing a setting means going to Build and coming back, which is a
 * fresh page. Session storage is per tab and goes when the tab closes, so
 * nothing survives between sessions.
 */
export function readPreviousEvaluation(): PreviousEvaluation | null {
  try {
    const raw = window.sessionStorage.getItem(PREVIOUS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PreviousEvaluation
    const ok = typeof p?.byId === "object" && p.byId !== null && !Array.isArray(p.byId) && typeof p?.summary?.total === "number"
    return ok ? p : null
  } catch {
    // Blocked storage, or something else wrote the key: compare nothing.
    return null
  }
}

export function storePreviousEvaluation(p: PreviousEvaluation): void {
  try {
    window.sessionStorage.setItem(PREVIOUS_KEY, JSON.stringify(p))
  } catch {
    // Private window or blocked storage: the page still works, it just forgets.
  }
}

// -------------------------------------------------------------- the change --

export type RowChange = "none" | "found" | "lost" | "up" | "down"

/** How this question did against the previous evaluation of the session. */
export function changeFor(now?: EvalPayload, before?: EvalPayload): RowChange {
  if (!now || !before) return "none"
  if (now.hit && !before.hit) return "found"
  if (!now.hit && before.hit) return "lost"
  if (!now.hit || !before.hit) return "none"
  const a = now.rank ?? 0
  const b = before.rank ?? 0
  if (a < b) return "up"
  if (a > b) return "down"
  return "none"
}

export function changeText(change: RowChange, before?: EvalPayload): string | null {
  if (change === "none") return null
  if (change === "found") return "was a miss"
  return before?.rank === null || before?.rank === undefined ? "was a miss" : `was rank ${before.rank}`
}

// ------------------------------------------------------------ the reranker --

/**
 * What the reranker did to the answer, counted from the rank each hit came
 * from (`prior_rank`) in the result the eval step read. It can only speak for
 * the questions that found the answer: for a miss there is no matched chunk to
 * look up, so the rank it held before the rerank is not in this data.
 */
export interface RerankEffect {
  up: number
  down: number
  same: number
  /** Questions this could be worked out for. */
  judged: number
}

type RankedRow = Pick<HitRowData, "rank" | "prior_rank" | "chunk_id">

export function rerankEffect(items: readonly { payload?: EvalPayload; rows?: readonly RankedRow[] }[]): RerankEffect {
  let up = 0
  let down = 0
  let same = 0
  for (const item of items) {
    const p = item.payload
    if (!p?.hit || !item.rows) continue
    const row = item.rows.find((r) => r.chunk_id === p.matched_chunk_id)
    if (!row || row.prior_rank === null || row.prior_rank === undefined) continue
    if (row.prior_rank > row.rank) up += 1
    else if (row.prior_rank < row.rank) down += 1
    else same += 1
  }
  return { up, down, same, judged: up + down + same }
}

export function rerankLine(e: RerankEffect): string | null {
  if (!e.judged) return null
  return `Rerank moved the answer up for ${e.up} of the ${e.judged} questions that found it, and down for ${e.down}.`
}
