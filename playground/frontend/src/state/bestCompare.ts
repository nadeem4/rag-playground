import type { EvalQuestionResult, Registry, ScoredRun, Stage } from "@/api/types"

import { strategyName } from "./compare"
import type { PipelineConfig, Step } from "./config"
import { STAGE_VERB } from "./graph"
import { fieldTitle, valueText } from "./recipeSentence"

/**
 * Compare the two, in Evaluate: what differs between this run's pipeline and
 * the best's, and which questions each run finds. Pure, so the panel and its
 * tests read the same words.
 */

export interface DiffRow {
  step: string
  now: string
  other: string
}

const one = (s: Step | undefined): Step[] => (s ? [s] : [])

/** Each step of a pipeline file, top to bottom, by the name Build's card gives it. Embed and Store share the Index card, so they keep the file's names. */
const SLOTS: { step: string; stage: Stage; of: (c: PipelineConfig) => Step[] }[] = [
  { step: STAGE_VERB.parse!, stage: "parse", of: (c) => [c.index.parse] },
  { step: STAGE_VERB.clean!, stage: "clean", of: (c) => c.index.clean ?? [] },
  { step: STAGE_VERB.chunk!, stage: "chunk", of: (c) => [c.index.chunk] },
  { step: STAGE_VERB.enrich!, stage: "enrich", of: (c) => one(c.index.enrich) },
  { step: "Embed", stage: "index", of: (c) => one(c.index.embed) },
  { step: "Store", stage: "index", of: (c) => [c.index.store] },
  { step: "Rewrite", stage: "query", of: (c) => one(c.retrieve?.rewrite) },
  { step: STAGE_VERB.retrieve!, stage: "retrieve", of: (c) => one(c.retrieve?.search) },
  { step: STAGE_VERB.rerank!, stage: "rerank", of: (c) => c.retrieve?.rerank ?? [] },
  { step: "Answer", stage: "use_case", of: (c) => one(c.answer) },
]

/** A value as JSON with each object's keys sorted, so settings kept in another order still match. */
const sorted = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  )
const same = (a: unknown, b: unknown) => sorted(a) === sorted(b)

/** One step in words: its strategy, then each of its settings the other side's step does not share. */
function stepText(stage: Stage, s: Step, them: Step | undefined, registry: Registry): string {
  const { use, ...settings } = s
  const schema = registry[stage]?.[use]?.config_schema ?? {}
  const parts = Object.entries(settings)
    .filter(([k, v]) => them?.use !== use || !same(v, them[k]))
    .map(([k, v]) => `${fieldTitle(k, schema)} ${valueText(k, v, schema)}`)
  return [strategyName(stage, use), ...parts].join(", ")
}

/** The steps whose strategy or settings differ, each side in words, then the names of the steps both share. */
export function pipelineDiff(now: PipelineConfig, other: PipelineConfig, registry: Registry = {}): { rows: DiffRow[]; same: string[] } {
  const rows: DiffRow[] = []
  const shared: string[] = []
  for (const slot of SLOTS) {
    const a = slot.of(now)
    const b = slot.of(other)
    if (!a.length && !b.length) continue
    if (same(a, b)) {
      shared.push(slot.step)
      continue
    }
    const words = (xs: Step[], ys: Step[]) => (xs.length ? xs.map((s, i) => stepText(slot.stage, s, ys[i], registry)).join(", then ") : "None")
    rows.push({ step: slot.step, now: words(a, b), other: words(b, a) })
  }
  return { rows, same: shared }
}

export interface QuestionPair {
  id: string
  question: string
  now: string
  other: string
}

export interface QuestionGroups {
  onlyOther: QuestionPair[]
  onlyNow: QuestionPair[]
  both: QuestionPair[]
  neither: QuestionPair[]
}

/** A question's result in words: its rank, or the step its trace says it was lost at, by the trace's own name. */
function cell(q: EvalQuestionResult): string {
  if (q.found) return q.rank === null ? "found" : `rank ${q.rank}`
  const at = q.lost_at ?? q.trace?.lost_at
  if (!at) return "missed"
  return `missed, lost at ${q.trace?.steps.find((s) => s.stage === at)?.name ?? at}`
}

/** Each question both runs scored, by id, in one of four groups: only the other run finds it, only this run, both, neither. */
export function questionGroups(now: readonly EvalQuestionResult[], other: readonly EvalQuestionResult[]): QuestionGroups {
  const theirs = new Map(other.map((q) => [q.id, q]))
  const groups: QuestionGroups = { onlyOther: [], onlyNow: [], both: [], neither: [] }
  for (const a of now) {
    const b = theirs.get(a.id)
    if (!b || a.error || b.error) continue
    const pair = { id: a.id, question: a.question, now: cell(a), other: cell(b) }
    groups[a.found ? (b.found ? "both" : "onlyNow") : b.found ? "onlyOther" : "neither"].push(pair)
  }
  return groups
}

/**
 * One line when the other pipeline, run again, found some questions
 * differently from its saved report, which the lost and won list above comes
 * from. Names the steps the run says can vary, else says something else
 * changed. Null when every question both scored agrees.
 */
export function rerunNote(
  rerun: readonly EvalQuestionResult[],
  saved: ScoredRun["questions"],
  nondeterministic: readonly string[],
  label: string,
): string | null {
  const before = new Map(saved.filter((q) => !q.error).map((q) => [q.id, q.found]))
  const n = rerun.filter((q) => !q.error && before.has(q.id) && before.get(q.id) !== q.found).length
  if (!n) return null
  const steps = nondeterministic.length < 2 ? nondeterministic.join("") : `${nondeterministic.slice(0, -1).join(", ")} and ${nondeterministic[nondeterministic.length - 1]}`
  const why = steps
    ? `${steps} can give a different result each run.`
    : "None of its steps say they can vary, so something else changed since then, such as the server's version."
  return `This time ${label} found ${n} ${n === 1 ? "question" : "questions"} differently from when it was saved, so these groups can differ from the list above. ${why}`
}
