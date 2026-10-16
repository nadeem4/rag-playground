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
  /** The found questions' keys (`questionKey`). */
  foundKeys: string[]
  /** The questions it could not score, left out of lost and won. */
  errored: string[]
}

export type Outcome =
  | { kind: "first" }
  | { kind: "better"; before: BestRun; more: number; won: string[] }
  | { kind: "worse"; best: BestRun; fewer: number; lost: string[] }
  | { kind: "equal"; best: BestRun }

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

/** As Pandion pairs questions: by id, or by text when the set gave it none ("question 3"). */
const questionKey = (q: Pick<EvalQuestionResult, "id" | "question">) => (/^question \d+$/.test(q.id) ? `text:${q.question}` : `id:${q.id}`)

/** The key a run is compared under, or null when the server sent no fingerprint. */
export function bestKey(r: EvaluationResult): string | null {
  if (!r.questions_fingerprint) return null
  return JSON.stringify([r.questions_fingerprint, r.document_shas ?? [], r.top_k])
}

const isBest = (b: unknown): b is BestRun => {
  const x = b as BestRun | null
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string")
  return (
    typeof x?.found === "number" &&
    typeof x.scored === "number" &&
    typeof x.name === "string" &&
    typeof x.at === "string" &&
    strings(x.foundKeys) &&
    strings(x.errored) &&
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
    foundKeys: r.questions.filter((q) => q.found && !q.error).map(questionKey),
    errored: r.questions.filter((q) => q.error).map(questionKey),
  }
  if (key === null) return { key, outcome: { kind: "first" } }
  const all = readAll()
  const stored = all[key]
  const store = () => writeAll({ ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)), [key]: run })
  if (!stored) {
    store()
    return { key, outcome: { kind: "first" } }
  }
  const was = new Set(stored.foundKeys)
  const both = r.questions.filter((q) => !q.error && !stored.errored.includes(questionKey(q)))
  const top = best([stored, run])
  if (top.length === 1 && top[0] === 1) {
    store()
    return { key, outcome: { kind: "better", before: stored, more: run.found - stored.found, won: both.filter((q) => q.found && !was.has(questionKey(q))).map((q) => q.question) } }
  }
  if (top.length === 1) {
    return { key, outcome: { kind: "worse", best: stored, fewer: stored.found - run.found, lost: both.filter((q) => !q.found && was.has(questionKey(q))).map((q) => q.question) } }
  }
  return { key, outcome: { kind: "equal", best: stored } }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const two = (n: number) => String(n).padStart(2, "0")

/** "today at 21:40", or "on 14 Oct at 09:05", in local time. */
export function whenText(at: string, now: Date = new Date()): string {
  const d = new Date(at)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? `today at ${time}` : `on ${d.getDate()} ${MONTHS[d.getMonth()]} at ${time}`
}
