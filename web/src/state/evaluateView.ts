import type { NodeState } from "@/api/runState"
import type { Registry } from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { strategyLabel } from "@/learn/challenges"

import { percent, pipelineSteps, type EvalMetrics, type RecipeStep } from "./evaluate"
import { askNodes, rewriteOf, type PipelineGraph } from "./graph"

/**
 * What the Evaluate page says around the score, kept pure so it is testable
 * without a browser: the numbers row, the progress line, the stale-k line and
 * the two recipe lines (the index side and the search side).
 */

/** One number in the row under the finding. `was` is the last run's value, only when it differs. */
export interface Figure {
  label: string
  value: string
  was: string | null
}

const rank = (r: number | null, digits: number) => (r === null ? "none" : r.toFixed(digits))

/**
 * The row of numbers: each by its plain name with the technical name in
 * brackets, the k it was scored at in the hit rate's name. Recall comes only
 * when some question has more than one passage, since otherwise it equals the
 * hit rate.
 */
export function numbersRow(now: EvalMetrics, before: EvalMetrics | null, k: number): Figure[] {
  const row: { label: string; of: (m: EvalMetrics) => string }[] = [
    { label: `Hit rate (Hit@${k})`, of: (m) => percent(m.hitRate) ?? "none" },
    { label: "Mean reciprocal rank (MRR)", of: (m) => (m.mrr === null ? "none" : m.mrr.toFixed(2)) },
    { label: "Average rank when found (mean rank)", of: (m) => rank(m.meanRank, 1) },
    { label: "Middle rank when found (median rank)", of: (m) => (m.medianRank === null ? "none" : String(m.medianRank)) },
  ]
  if (now.recall !== null) row.push({ label: `Evidence found (recall at ${k})`, of: (m) => percent(m.recall) ?? "none" })
  return row.map(({ label, of }) => {
    const value = of(now)
    const then = before ? of(before) : null
    return { label, value, was: then !== null && then !== value ? then : null }
  })
}

/** The index line while a run goes: from the cache, built now, or the step building. */
export interface IndexLine {
  label: string
  cached: boolean
}

/**
 * `states` are one variant's node states; the index steps are shared, so the
 * first question's say it for all. `name` gives a node's plain step name.
 */
export function indexLine(states: Record<string, NodeState>, indexIds: readonly string[], name: (id: string) => string): IndexLine {
  const mine = indexIds.map((id) => states[id]).filter((s): s is NodeState => s !== undefined)
  const running = indexIds.find((id) => states[id]?.status === "running")
  if (running) return { label: `Building: ${name(running)}`, cached: false }
  if (mine.length === 0 || mine.every((s) => s.status === "pending")) return { label: "Waiting to start", cached: false }
  if (mine.length === indexIds.length && mine.every((s) => s.status === "cached")) return { label: "From the cache", cached: true }
  return { label: "Built now", cached: false }
}

/** "Searching and scoring question 3 of 6. 2 searches came from the cache." */
export function progressLine(scored: number, total: number, cachedSearches: number): string {
  if (scored >= total) return `Scored all ${total} ${total === 1 ? "question" : "questions"}.`
  const head = `Searching and scoring question ${scored + 1} of ${total}.`
  if (cachedSearches === 0) return head
  return `${head} ${cachedSearches} ${cachedSearches === 1 ? "search came" : "searches came"} from the cache.`
}

/** After a run, a new Pieces checked does not relabel the run: it says to evaluate again. */
export function staleLine(scoredK: number | null, topK: number): string | null {
  if (scoredK === null || scoredK === topK) return null
  return `Scored at ${scoredK} ${scoredK === 1 ? "piece" : "pieces"}. Evaluate again to use ${topK}.`
}

const INDEX_LABELS = ["Parse", "Clean", "Chunk", "Index"]

/** Parse, Clean, Chunk and Index, each by plain name and code name. */
export function indexSteps(g: PipelineGraph): RecipeStep[] {
  return pipelineSteps(g).filter((s) => INDEX_LABELS.includes(s.label))
}

/** One part of the search side: `Retrieve: Hybrid (RRF), hybrid_rrf, returns 10`. */
export interface SearchStep {
  label: "Rewrite" | "Retrieve" | "Rerank"
  name: string
  transform: string | null
  detail: string | null
}

const REWRITE_NAME = { none: "None", prf: "PRF", llm: "LLM rewrite" } as const

/** Rewrite, Retrieve with how many pieces it returns, and Rerank. */
export function searchSteps(g: PipelineGraph, registry?: Registry): SearchStep[] {
  const { retrieve, rerank } = askNodes(g)
  const mode = rewriteOf(g)
  const defaultTopK = retrieve ? registry?.retrieve?.[retrieve.transform]?.config_schema?.properties?.top_k?.default : undefined
  const topK = retrieve ? (retrieve.config.top_k ?? defaultTopK) : undefined
  return [
    { label: "Rewrite", name: REWRITE_NAME[mode], transform: null, detail: null },
    {
      label: "Retrieve",
      name: retrieve ? (RETRIEVAL_LABEL[retrieve.transform] ?? strategyLabel(retrieve.transform)) : "None",
      transform: retrieve?.transform ?? null,
      detail: typeof topK === "number" ? `returns ${topK}` : null,
    },
    { label: "Rerank", name: rerank ? strategyLabel(rerank.transform) : "None", transform: rerank?.transform ?? null, detail: null },
  ]
}

/** A gold passage written as a table row (`| a | b |`) as its cells, else null. */
export function evidenceCells(gold: string): string[] | null {
  const t = gold.trim()
  if (!t.startsWith("|") || !t.endsWith("|")) return null
  const cells = t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim())
  return cells.length > 1 ? cells : null
}
