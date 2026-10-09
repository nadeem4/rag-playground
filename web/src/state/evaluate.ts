import type {
  EvalOutput,
  EvalPayload,
  GraphNode,
  Registry,
  SampleQuestion,
  Stage,
  Trace,
  TraceRequest,
  TraceStage,
  Variant,
} from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { ordinal, type HitRowData } from "@/components/inspectors/hits"
import { strategyLabel } from "@/learn/challenges"

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

/**
 * The most recipes one sweep takes. The server refuses more (it bounds what a
 * single request can ask of the hosted demo), so an evaluation with more
 * questions runs as several sweeps, one after another.
 */
export const SWEEP_LIMIT = 10

/** `items` cut into runs of at most `size`, each with the index of its first item. */
export function batches<T>(items: readonly T[], size: number): { offset: number; items: T[] }[] {
  const out: { offset: number; items: T[] }[] = []
  for (let offset = 0; offset < items.length; offset += size) out.push({ offset, items: items.slice(offset, offset + size) })
  return out
}

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

/** One step of the recipe: its column title, its code name and its plain name (`Docling`, `docling`). */
export interface RecipeStep {
  label: string
  transform: string
  name: string
  /** The step's settings as JSON, so the next run can tell a settings change from none. Absent on older entries. */
  config?: string
}

export function pipelineSteps(g: PipelineGraph): RecipeStep[] {
  return columnOrder(g)
    .filter((n) => DESCRIBED.includes(n.stage))
    .map((n) => ({
      label: titleFor(n),
      transform: n.transform,
      // Retrieve goes by the Ask panel's name, every other step by Build's.
      name: (n.stage === "retrieve" ? RETRIEVAL_LABEL[n.transform] : undefined) ?? strategyLabel(n.transform),
      config: JSON.stringify(n.config),
    }))
}

/**
 * What `POST /api/trace` needs to follow one question's answer down its run:
 * each step's artifact and plain name, in column order. The result the eval
 * step scored is the reranker's when there is one. Null until every step it
 * reads has finished for this question, or when there is no answer to look for.
 */
export function traceRequest(
  g: PipelineGraph,
  artifact: (nodeId: string) => string | undefined,
  golds: readonly string[],
  topK: number,
): TraceRequest | null {
  const order = columnOrder(g)
  const one = (stage: Stage) => order.find((n) => n.stage === stage)
  const parse = one("parse")
  const chunk = one("chunk")
  const retrieve = one("retrieve")
  const rerank = one("rerank")
  const cleans = order.filter((n) => n.stage === "clean")
  const ids = [parse, chunk, retrieve, rerank, ...cleans].filter((n) => n !== undefined).map((n) => artifact(n.id))
  if (!parse || !chunk || !retrieve || !golds.length || ids.some((id) => id === undefined)) return null
  return {
    gold_answers: [...golds],
    parse: { id: artifact(parse.id)!, name: strategyLabel(parse.transform) },
    cleans: cleans.map((n) => ({ id: artifact(n.id)!, name: strategyLabel(n.transform) })),
    chunk: artifact(chunk.id)!,
    retrieve: artifact(retrieve.id)!,
    final: artifact((rerank ?? retrieve).id)!,
    rerank_name: rerank ? strategyLabel(rerank.transform) : null,
    top_k: topK,
  }
}

/** The Build card a lost trace step belongs to. Top k has none: it is set on Evaluate. */
const TRACE_STAGE: Partial<Record<TraceStage, Stage>> = {
  parse: "parse",
  clean: "clean",
  chunk: "chunk",
  search: "retrieve",
  rerank: "rerank",
}

/**
 * Where "Change this step on Build" goes: Build with the lost step's card
 * open. The nth Clean step of the trace is the nth Clean card. Null when
 * nothing was lost, or the lost step has no card.
 */
export function fixHref(g: PipelineGraph, trace: Trace): string | null {
  const at = trace.steps.findIndex((s) => s.status === "lost")
  if (at < 0) return null
  const stage = TRACE_STAGE[trace.steps[at].stage]
  if (!stage) return null
  const nth = trace.steps.slice(0, at).filter((s) => s.stage === trace.steps[at].stage).length
  const node = columnOrder(g).filter((n) => n.stage === stage)[nth]
  return node ? `/build?step=${encodeURIComponent(node.id)}` : null
}

/** A pipeline's steps in one line, by their plain names: a pipeline picker's help line. */
export function pipelineLine(g: PipelineGraph): string {
  return pipelineSteps(g)
    .map((s) => s.name)
    .join(", ")
}

// ------------------------------------------------- too few pieces, a miss --

/**
 * A score over a handful of pieces is flattered: when the top k is most of
 * the pieces, the answer is found by chance. A miss still says a lot, so a run
 * with misses is worded for them. "The answer was in none of the pieces" is
 * said only when every miss was absent from everything that came back and
 * everything the pipeline made came back; otherwise the miss is only known to
 * be below the top k. Null when the count is unknown or there are enough
 * pieces for the score to mean something.
 */
export function piecesWarning(pieces: number | null, topK: number, misses: readonly EvalPayload[]): string | null {
  if (pieces === null || pieces > 2 * topK) return null
  if (misses.length > 0) {
    const nowhere = misses.every((p) => p.found_at === null && p.returned === pieces)
    const where = nowhere ? `the answer was in none of the ${pieces} pieces` : `its answer was not in the top ${topK}`
    return `With ${pieces} ${pieces === 1 ? "piece" : "pieces"} and ${topK} checked, a hit says little. A miss still says a lot: ${where}.`
  }
  if (pieces <= topK) {
    return `This pipeline makes only ${pieces} ${pieces === 1 ? "piece" : "pieces"}, so every question finds its answer. The score says nothing here.`
  }
  return `This pipeline makes only ${pieces} pieces and checks ${topK} of them, so a question can find its answer by chance. Use smaller pieces or check fewer to make the score mean more.`
}

/**
 * Why a row reads as it does, in one sentence: where a hit was found, or why
 * a question missed (ranked below the pieces checked, or not among the pieces
 * that came back at all). An older payload has no `returned`, so it says what
 * was checked.
 */
export function reasonText(p: EvalPayload, topK: number): string {
  if (p.hit) {
    const where = typeof p.rank === "number" ? `Found in the ${ordinal(p.rank)} piece` : `Found in the top ${topK} pieces`
    return `${where}, ${p.match === "normalized" ? "after ignoring spacing and capitals" : "word for word"}.`
  }
  if (typeof p.found_at === "number") return `Found ${ordinal(p.found_at)}, below the ${topK} ${topK === 1 ? "piece" : "pieces"} checked.`
  if (typeof p.returned === "number") {
    return `Not in any of the ${p.returned} ${p.returned === 1 ? "piece" : "pieces"} that came back, so no number of pieces checked would find it.`
  }
  return `${p.considered} of ${p.total_candidates} checked`
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

/** The score as a finding sentence, and the line under it. */
export interface ScoreFinding {
  /** `3 of 5 questions found the answer. The last run found 5 of 5.` */
  finding: string
  /** `Hit rate at 5 pieces: 60%.` and, when it says something, why. */
  sub: string
  /** `sub` without the hit rate, which the numbers row shows: empty when there is nothing more to say. */
  note: string
}

/**
 * What changed since the last run, when it was one step and nothing else:
 * `Parse changed to Fast text`, or `Chunk's settings changed` when only its
 * settings did. Null when nothing, several steps, or the pieces checked
 * changed. Settings are compared only when both runs stored them.
 */
function changedStep(previous: PreviousEvaluation, now: readonly RecipeStep[], k: number): string | null {
  const before = previous.steps
  if (!before || before.length !== now.length || now.some((s, i) => s.label !== before[i].label)) return null
  if (previous.k !== undefined && previous.k !== k) return null
  const settings = (s: RecipeStep, i: number) => s.config !== undefined && before[i].config !== undefined && s.config !== before[i].config
  const changed = now.flatMap((s, i) => (s.transform !== before[i].transform || settings(s, i) ? [i] : []))
  if (changed.length !== 1) return null
  const i = changed[0]
  return now[i].transform !== before[i].transform ? `${now[i].label} changed to ${now[i].name}` : `${now[i].label}'s settings changed`
}

const COUNT_WORDS: Record<number, string> = { 2: "Both" }

/**
 * The score as one sentence with the last run beside it, then the hit rate and
 * the one thing worth saying about it: every answer came back first, or how
 * many misses are new and since what. A change is named only when exactly one
 * step's transform differs from the last run's recipe; an older stored run
 * has no recipe, so it reads "since the last run".
 */
export function scoreFinding(
  summary: EvalSummary,
  previous: PreviousEvaluation | null,
  rows: readonly { now?: EvalPayload; before?: EvalPayload }[],
  steps: readonly RecipeStep[],
  k: number,
): ScoreFinding {
  const noun = summary.total === 1 ? "question" : "questions"
  const head = `${summary.hits} of ${summary.total} ${noun} found the answer.`
  const finding = previous ? `${head} The last run found ${previous.summary.hits} of ${previous.summary.total}.` : head
  const rate = percent(summary.total ? summary.hits / summary.total : null) ?? "not yet"
  const base = `Hit rate at ${k} ${k === 1 ? "piece" : "pieces"}: ${rate}.`

  const scored = rows.filter((r): r is { now: EvalPayload; before?: EvalPayload } => r.now !== undefined)
  if (scored.length > 0 && scored.length === rows.length && scored.every((r) => r.now.hit && r.now.rank === 1)) {
    return { finding, sub: `${base} Every answer came back as the top piece.`, note: "Every answer came back as the top piece." }
  }
  const misses = scored.filter((r) => !r.now.hit)
  const lost = misses.filter((r) => changeFor(r.now, r.before) === "lost").length
  if (!previous || lost === 0) return { finding, sub: base, note: "" }
  const step = changedStep(previous, steps, k)
  const since = step ? `since ${step}.` : "since the last run."
  const count =
    lost < misses.length
      ? `${lost} of the ${misses.length} misses ${lost === 1 ? "is" : "are"} new`
      : lost === 1
        ? "The miss is new"
        : `${COUNT_WORDS[lost] ?? `All ${lost}`} misses are new`
  return { finding, sub: `${base} ${count} ${since}`, note: `${count} ${since}` }
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
  /** The document it was scored against (F5), so a later document never borrows its numbers. */
  sourceSha: string
  /** The pipeline it was scored with: a saved pipeline's id, or "working" for the pipeline on Build. */
  pipelineKey: string
  byId: Record<string, EvalPayload>
  summary: EvalSummary
  /** The recipe it was scored with, so the next run can name the one step that changed. Absent on older entries. */
  steps?: RecipeStep[]
  /** The pieces checked it was scored at. Absent on older entries. */
  k?: number
}

const PREVIOUS_KEY = "rag-playground:evaluation:previous"

/**
 * The previous evaluation is kept in session storage rather than React state,
 * because changing a setting means going to Build and coming back, which is a
 * fresh page. Session storage is per tab and goes when the tab closes, so
 * nothing survives between sessions.
 *
 * A result belongs to one document and one pipeline. `sourceSha` is the
 * document on screen now and `pipelineKey` is the pipeline chosen now. A
 * stored result for a different document (score the primer, load Scanned
 * notes) or a different pipeline is not a "previous run" of this one, so it
 * is treated as if there were none (F5).
 */
const MAX_PREVIOUS = 40

const isPrevious = (p: unknown): p is PreviousEvaluation => {
  const e = p as PreviousEvaluation | null
  return (
    typeof e?.sourceSha === "string" &&
    typeof e?.pipelineKey === "string" &&
    typeof e?.byId === "object" &&
    e.byId !== null &&
    !Array.isArray(e.byId) &&
    typeof e?.summary?.total === "number" &&
    (e.steps === undefined || (Array.isArray(e.steps) && e.steps.every((x) => typeof x?.label === "string" && typeof x?.transform === "string" && typeof x?.name === "string" && (x.config === undefined || typeof x.config === "string")))) &&
    (e.k === undefined || typeof e.k === "number")
  )
}

/**
 * Every stored score, keyed by `${sourceSha}|${pipelineKey}` (I2), so scoring
 * A, then B, then A again still compares A against A. Anything that is not an
 * entry of that shape is dropped, which is how the old single-slot value (one
 * evaluation, not a map) reads as none.
 */
function readPreviousMap(): Record<string, PreviousEvaluation> {
  try {
    const raw = window.sessionStorage.getItem(PREVIOUS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => isPrevious(v) && k === `${v.sourceSha}|${v.pipelineKey}`),
    )
  } catch {
    // Blocked storage, or something else wrote the key: compare nothing.
    return {}
  }
}

export function readPreviousEvaluation(sourceSha: string, pipelineKey: string): PreviousEvaluation | null {
  return readPreviousMap()[`${sourceSha}|${pipelineKey}`] ?? null
}

/** Writes this score and keeps the others, up to 40; the oldest written goes first. */
export function storePreviousEvaluation(p: PreviousEvaluation): void {
  const key = `${p.sourceSha}|${p.pipelineKey}`
  const rest = Object.entries(readPreviousMap()).filter(([k]) => k !== key)
  const next = Object.fromEntries([...rest, [key, p] as const].slice(-MAX_PREVIOUS))
  try {
    window.sessionStorage.setItem(PREVIOUS_KEY, JSON.stringify(next))
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

/** What the row was last run: `Was found 1st`, `Was missed`. */
export function changeText(change: RowChange, before?: EvalPayload): string | null {
  if (change === "none") return null
  if (change === "found") return "Was missed"
  return before?.rank === null || before?.rank === undefined ? "Was missed" : `Was found ${ordinal(before.rank)}`
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
