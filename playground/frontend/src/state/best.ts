import type { EvalQuestionResult, EvaluationResult } from "@/api/types"

import { isConfigShape, type WorkingPipeline } from "./config"

/**
 * Best so far: the best Evaluate run in this browser for one question set,
 * one set of documents and one Pieces checked (the key Pandion's
 * `report.against` compares by). After a run the page says whether it beat
 * the best, fell short of it, or matched it, and names the questions that
 * changed. Kept in localStorage; a blocked or broken store reads as no best.
 */

/** What a best run keeps: enough to open it on Build and to tell lost and won questions. */
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
  /** Each question, to pair with a later run's: its own id (null for a positional "question 3"), its text, and how it did. */
  questions: BestQuestion[]
}

export interface BestQuestion {
  id: string | null
  text: string
  found: boolean
  /** It could not be scored, so it is left out of lost and won. */
  errored: boolean
}

export type Outcome =
  | { kind: "first" }
  /** `more` and `fewer` count over the paired questions neither run errored on; `tie` is equal hit rates, so MRR decided. */
  | { kind: "better"; before: BestRun; more: number; tie: boolean; won: string[] }
  | { kind: "worse"; best: BestRun; fewer: number; tie: boolean; lost: string[] }
  | { kind: "equal"; best: BestRun; found: number; scored: number }

export const BEST_KEY = "rag-playground:best:v1"
const MAX_BEST = 40

type Scored = { scored: number; found: number; hit_rate: number | null; mrr: number | null }

/**
 * A copy of `pandion.evaluation.best`: the places of the best runs, every one
 * tied for first, by the highest hit rate, then the highest MRR. Empty when no
 * run was scored or none found an answer.
 */
export function best(runs: readonly Scored[]): number[] {
  const scored = runs.flatMap((r, n) => (r.scored ? [n] : []))
  if (!scored.some((n) => runs[n].found)) return []
  const key = (n: number) => [runs[n].hit_rate ?? 0, runs[n].mrr ?? 0] as const
  const top = scored.map(key).reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a))
  return scored.filter((n) => key(n)[0] === top[0] && key(n)[1] === top[1])
}

/** A question as a best run keeps it. A positional id ("question 3") is no id: it moves when the set is reordered. */
const asBest = (q: EvalQuestionResult): BestQuestion => ({ id: /^question \d+$/.test(q.id) ? null : q.id, text: q.question, found: q.found && !q.error, errored: q.error !== null })

/**
 * Pair this run's questions with the best's as `pandion.evaluation._regression`
 * does: by id over the whole set first, then the rest by text. Returns the
 * pairs neither run errored on.
 */
function pairs(now: BestQuestion[], before: BestQuestion[]): [BestQuestion, BestQuestion][] {
  const partner = new Map<number, BestQuestion>()
  const taken = new Set<BestQuestion>()
  const byId = new Map(before.filter((b) => b.id !== null).map((b) => [b.id, b] as const))
  now.forEach((q, n) => {
    const b = q.id !== null ? byId.get(q.id) : undefined
    if (b && !taken.has(b)) {
      partner.set(n, b)
      taken.add(b)
    }
  })
  now.forEach((q, n) => {
    if (partner.has(n)) return
    const b = before.find((x) => !taken.has(x) && x.text === q.text)
    if (b) {
      partner.set(n, b)
      taken.add(b)
    }
  })
  return [...partner].sort(([a], [b]) => a - b).flatMap(([n, b]) => (now[n].errored || b.errored ? [] : [[now[n], b] as [BestQuestion, BestQuestion]]))
}

/** The key a run is compared under, or null when the server sent no fingerprint. */
export function bestKey(r: EvaluationResult): string | null {
  if (!r.questions_fingerprint) return null
  return JSON.stringify([r.questions_fingerprint, r.document_shas ?? [], r.top_k])
}

const isBest = (b: unknown): b is BestRun => {
  const x = b as BestRun | null
  return (
    typeof x?.found === "number" &&
    typeof x.scored === "number" &&
    typeof x.name === "string" &&
    typeof x.at === "string" &&
    Array.isArray(x.questions) &&
    x.questions.every((q) => (q?.id === null || typeof q?.id === "string") && typeof q.text === "string" && typeof q.found === "boolean" && typeof q.errored === "boolean") &&
    isConfigShape(x.pipeline?.config) &&
    Array.isArray(x.pipeline.documents)
  )
}

function readAll(): Record<string, BestRun> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BEST_KEY) ?? "null") as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isBest(v))) as Record<string, BestRun>
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
 * it is the first or better. Lost and won are question texts; a question
 * either run could not score is left out, as in the package.
 */
export function afterRun(r: EvaluationResult, name: string, pipeline: BestPipeline, at: Date = new Date()): { key: string | null; outcome: Outcome } {
  const key = bestKey(r)
  const run: BestRun = {
    found: r.found,
    scored: r.scored,
    hit_rate: r.hit_rate,
    mrr: r.mrr,
    name,
    pipeline,
    at: at.toISOString(),
    questions: r.questions.map(asBest),
  }
  if (key === null) return { key, outcome: { kind: "first" } }
  const all = readAll()
  const stored = all[key]
  const store = () => writeAll({ ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)), [key]: run })
  if (!stored) {
    store()
    return { key, outcome: { kind: "first" } }
  }
  // Counted over the paired questions neither run errored on, as Regression counts them.
  const paired = pairs(run.questions, stored.questions)
  const lost = paired.filter(([q, b]) => b.found && !q.found).map(([q]) => q.text)
  const won = paired.filter(([q, b]) => q.found && !b.found).map(([q]) => q.text)
  const tie = run.hit_rate === stored.hit_rate
  const top = best([stored, run])
  if (top.length === 1 && top[0] === 1) {
    store()
    return { key, outcome: { kind: "better", before: stored, more: won.length - lost.length, tie, won } }
  }
  if (top.length === 1) {
    return { key, outcome: { kind: "worse", best: stored, fewer: lost.length - won.length, tie, lost } }
  }
  return { key, outcome: { kind: "equal", best: stored, found: run.found, scored: run.scored } }
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
