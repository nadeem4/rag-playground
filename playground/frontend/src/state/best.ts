import type { EvaluationResult, ScoredRun } from "@/api/types"
import { v2 } from "@/api/v2"

import { isConfigShape, type WorkingPipeline } from "./config"

/**
 * Best so far: the best Evaluate run in this browser for one question set,
 * one set of documents and one Pieces checked (the key Pandion's
 * `report.against` compares by). After a run the page says whether it beat
 * the best, fell short of it, or matched it, and names the questions that
 * changed. Kept in localStorage; a blocked or broken store reads as no best.
 */

/** What a best run keeps: enough to open it on Build and for Pandion to compare a later run with it. */
export type BestPipeline = WorkingPipeline

export interface BestRun {
  found: number
  scored: number
  hit_rate: number | null
  mrr: number | null
  /** The pipeline's name in the picker. */
  name: string
  pipeline: BestPipeline
  /** When it ran, as an ISO string. */
  at: string
  /** The run as Pandion compares it (`POST /api/v2/evaluations/against`). */
  report: ScoredRun
}

export type Outcome =
  | { kind: "first" }
  /** `more` and `fewer` count over the questions both runs scored; `tie` is equal hit rates, so MRR decided. `notes` are Pandion's. */
  | { kind: "better"; before: BestRun; more: number; tie: boolean; won: string[]; notes: string[] }
  | { kind: "worse"; best: BestRun; fewer: number; tie: boolean; lost: string[]; notes: string[] }
  | { kind: "equal"; best: BestRun; found: number; scored: number; notes: string[] }

export const BEST_KEY = "rag-playground:best:v1"
const MAX_BEST = 40

/** The part of an evaluation result Pandion's comparison reads: what a best run keeps of one. */
export function scoredRun(r: EvaluationResult): ScoredRun {
  return {
    top_k: r.top_k,
    questions_fingerprint: r.questions_fingerprint ?? null,
    document_shas: r.document_shas ?? [],
    nondeterministic: r.nondeterministic ?? [],
    scored: r.scored,
    found: r.found,
    hit_rate: r.hit_rate,
    mrr: r.mrr,
    questions: r.questions.map((q) => ({ id: q.id, question: q.question, found: q.found, error: q.error })),
  }
}

/** The key a run is compared under, or null when the server sent no fingerprint. */
export function bestKey(r: EvaluationResult): string | null {
  if (!r.questions_fingerprint) return null
  return JSON.stringify([r.questions_fingerprint, r.document_shas ?? [], r.top_k])
}

const isScoredRun = (x: ScoredRun | undefined): x is ScoredRun =>
  typeof x?.top_k === "number" &&
  Array.isArray(x.questions) &&
  x.questions.every((q) => typeof q?.id === "string" && typeof q.question === "string" && typeof q.found === "boolean")

const isBest = (b: unknown): b is BestRun => {
  const x = b as BestRun | null
  return (
    typeof x?.found === "number" &&
    typeof x.scored === "number" &&
    typeof x.name === "string" &&
    typeof x.at === "string" &&
    isScoredRun(x.report) &&
    isConfigShape(x.pipeline?.config) &&
    Array.isArray(x.pipeline.documents)
  )
}

/** A question as this browser kept it before Pandion compared runs. */
interface OldQuestion {
  id: string | null
  text: string
  found: boolean
  errored: boolean
}

/**
 * A best kept before Pandion compared runs, with its questions as
 * `{id, text, found, errored}`, made into a `report` from them and the key
 * it was kept under. Anything else is left as it is.
 */
function upgraded(key: string, value: unknown): unknown {
  const old = value as (Omit<BestRun, "report"> & { questions?: OldQuestion[]; report?: unknown }) | null
  if (!old || old.report !== undefined || !Array.isArray(old.questions)) return value
  try {
    const [fingerprint, shas, topK] = JSON.parse(key) as [string, string[], number]
    if (!old.questions.every((q) => typeof q?.text === "string" && typeof q.found === "boolean")) return value
    const { questions, ...rest } = old
    const report: ScoredRun = {
      top_k: topK,
      questions_fingerprint: fingerprint,
      document_shas: shas,
      nondeterministic: [],
      scored: old.scored,
      found: old.found,
      hit_rate: old.hit_rate,
      mrr: old.mrr,
      questions: questions.map((q, n) => ({ id: q.id ?? `question ${n + 1}`, question: q.text, found: q.found, error: q.errored ? "not scored" : null })),
    }
    return { ...rest, report }
  } catch {
    return value
  }
}

function readAll(): Record<string, BestRun> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BEST_KEY) ?? "null") as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, upgraded(k, v)] as const).filter(([, v]) => isBest(v))) as Record<string, BestRun>
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, BestRun>): void {
  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_BEST))))
  } catch {
    // Private window or blocked storage: the page still works, it just forgets.
  }
}

export function readBest(key: string): BestRun | null {
  return readAll()[key] ?? null
}

export function forgetBest(key: string): void {
  const { [key]: _gone, ...rest } = readAll()
  writeAll(rest)
}

/**
 * Compare a finished run with the best stored under its key, and store it when
 * it is the first or better. Pandion pairs the questions and decides which run
 * is better (`POST /api/v2/evaluations/against`); lost and won are question
 * texts, and a question either run could not score is left out.
 */
export async function afterRun(
  r: EvaluationResult,
  name: string,
  pipeline: BestPipeline,
  at: Date = new Date(),
): Promise<{ key: string | null; outcome: Outcome }> {
  const key = bestKey(r)
  const report = scoredRun(r)
  const run: BestRun = { found: r.found, scored: r.scored, hit_rate: r.hit_rate, mrr: r.mrr, name, pipeline, at: at.toISOString(), report }
  if (key === null) return { key, outcome: { kind: "first" } }
  const stored = readAll()[key]
  const store = () => {
    const all = readAll()
    writeAll({ ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)), [key]: run })
  }
  if (!stored) {
    store()
    return { key, outcome: { kind: "first" } }
  }
  const verdict = await v2.against(report, stored.report)
  const text = new Map(r.questions.map((q) => [q.id, q.question]))
  const lost = verdict.newly_missed.map((id) => text.get(id) ?? id)
  const won = verdict.newly_found.map((id) => text.get(id) ?? id)
  const tie = run.hit_rate === stored.hit_rate
  const { notes } = verdict
  if (verdict.best.length === 1 && verdict.best[0] === 1) {
    store()
    return { key, outcome: { kind: "better", before: stored, more: won.length - lost.length, tie, won, notes } }
  }
  if (verdict.best.length === 1) {
    return { key, outcome: { kind: "worse", best: stored, fewer: lost.length - won.length, tie, lost, notes } }
  }
  return { key, outcome: { kind: "equal", best: stored, found: run.found, scored: run.scored, notes } }
}

/**
 * The outcome's first sentence, which the page's live region reads out. Null
 * is the best forgotten. "Ranks higher" is said only when the hit rates are
 * equal, so MRR alone decided; a count is said only when it is above zero.
 */
export function bestHeadline(o: Outcome | null): string {
  if (o === null) return "Best forgotten."
  switch (o.kind) {
    case "first":
      return "Your first run with these questions, so it is your best so far."
    case "equal":
      return `Same as your best: ${o.found} of ${o.scored}.`
    case "better":
      return "New best."
    case "worse":
      return o.tie ? "Your best ranks the answers higher." : o.fewer > 0 ? `${o.fewer} fewer found than your best.` : "A lower hit rate than your best."
  }
}

/** What follows "New best.": how it beat the last best, in the same rule as the worse headline. */
export function betterLine(o: Extract<Outcome, { kind: "better" }>): string {
  return o.tie ? "The answers rank higher than in the last best" : o.more > 0 ? `${o.more} more found than the last best` : "A higher hit rate than the last best"
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const two = (n: number) => String(n).padStart(2, "0")

/** "today at 21:40", or "on 14 Oct at 09:05", in local time. */
export function whenText(at: string, now: Date = new Date()): string {
  const d = new Date(at)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? `today at ${time}` : `on ${d.getDate()} ${MONTHS[d.getMonth()]} at ${time}`
}
