import { ApiError } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { V2AskRequest, V2RunRequest } from "@/api/types"
import { errorsFromPydantic, type FieldErrors, type PydanticError } from "@/components/fields/schema"

import { cardNamedIn, stepOfCardIn, type WorkingPipeline } from "./config"
import type { PipelineGraph } from "./graph"

/**
 * The Build page's run plumbing, kept pure so it is testable without a
 * browser: the request a button sends, where a failure is shown, and how the
 * results of partial runs accumulate.
 */

/**
 * The run a card's Run button sends: the pipeline through that card's step,
 * on the pipeline's documents. The Document card has no step of its own; it
 * runs through Parse, which reads it. A Clean card's step is its place in
 * `graph`, the column the pipeline was made from.
 */
export function cardRun(p: WorkingPipeline, card: string, force: boolean, graph: PipelineGraph): V2RunRequest {
  const through = card === "source" ? "parse" : stepOfCardIn(graph, card)
  return { config: p.config, documents: p.documents.map((d) => d.sha), through, ...(force ? { force: true } : {}) }
}

/** What Ask sends: the question on the pipeline's documents, through the answer or only the search. */
export function askRun(p: WorkingPipeline, opts: { answer: boolean; force: boolean }): V2AskRequest {
  return {
    config: p.config,
    documents: p.documents.map((d) => d.sha),
    question: p.question.text,
    answer: opts.answer,
    ...(opts.force ? { force: true } : {}),
  }
}

export type RoutedError =
  | { kind: "fields"; nodeId: string; errors: FieldErrors }
  | { kind: "node"; nodeId: string; message: string }
  | { kind: "column"; message: string }

interface ConfigErrorDetail {
  node_id: string
  errors: PydanticError[]
}

function isConfigError(d: unknown): d is ConfigErrorDetail {
  return (
    typeof d === "object" && d !== null && typeof (d as ConfigErrorDetail).node_id === "string" && Array.isArray((d as ConfigErrorDetail).errors)
  )
}

/** A /api/v2 refusal: `{problems: [...]}`, one sentence per problem. */
const isProblems = (d: unknown): d is { problems: string[] } =>
  typeof d === "object" && d !== null && Array.isArray((d as { problems?: unknown }).problems)

/** A request FastAPI refused field by field: `[{loc, msg}, ...]`. */
const isPydanticList = (d: unknown): d is PydanticError[] =>
  Array.isArray(d) && d.length > 0 && d.every((e) => typeof e === "object" && e !== null && typeof (e as PydanticError).msg === "string")

/** One refused field as a sentence: "question: String should have at most 2000 characters." */
function sentenceOf(e: PydanticError): string {
  const where = (Array.isArray(e.loc) ? e.loc : []).filter((part) => part !== "body").join(".")
  const msg = /[.!?]$/.test(e.msg) ? e.msg : `${e.msg}.`
  return where ? `${where}: ${msg}` : msg
}

/**
 * The settings a Pandion problem sentence is about, as `pandion.stages` words it:
 * "index.chunk (sentence_window): overlap_sentences: Overlap must be ...", with
 * several settings joined by "; ". Each comes back with its own sentence. Null
 * for a sentence about anything else, or about the whole step ("settings: ..."),
 * which no one setting owns.
 */
export function settingProblems(sentence: string): { transform: string; settings: { field: string; message: string }[] } | null {
  const m = /^[\w.]+(?: step \d+)? \(([\w-]+)\): (.+?)\.?$/.exec(sentence)
  if (!m) return null
  const settings = m[2].split("; ").map((part) => /^([\w.]+): (.+?)\.?$/.exec(part))
  if (settings.some((x) => !x || x[1] === "settings")) return null
  return { transform: m[1], settings: settings.map((x) => ({ field: x![1], message: `${x![2]}.` })) }
}

/** A refusal's detail as sentences: FastAPI's own list, a string, or null for any other shape. */
export function detailSentences(detail: unknown): string | null {
  if (isPydanticList(detail)) return detail.map(sentenceOf).join(" ")
  return typeof detail === "string" && detail ? detail : null
}

/** The node a graph-validation message is about, if it names exactly one. */
function nodeNamedIn(message: string, graph: PipelineGraph): string | null {
  const ids = new Set(graph.nodes.map((n) => n.id))
  // "edge a->b...": the edge belongs to the node it feeds.
  const edge = /edge ([\w-]+)->([\w-]+)/.exec(message)
  if (edge && ids.has(edge[2])) return edge[2]
  const named = new Set(message.split(/[^\w-]+/).filter((tok) => ids.has(tok)))
  return named.size === 1 ? [...named][0] : null
}

/** Where on the page a failed run request (`/api/v2/runs`, `/api/v2/ask`, or an old route) is shown. */
export function routeRunError(err: unknown, graph: PipelineGraph): RoutedError {
  if (err instanceof ApiError) {
    if (isProblems(err.detail)) {
      const message = err.detail.problems.join(" ")
      // On one card only when every problem names that card and the column has it.
      const cards = new Set(err.detail.problems.map((problem) => cardNamedIn(problem, graph)))
      const [card] = cards
      return cards.size === 1 && card && graph.nodes.some((n) => n.id === card) ? { kind: "node", nodeId: card, message } : { kind: "column", message }
    }
    if (isPydanticList(err.detail)) return { kind: "column", message: err.detail.map(sentenceOf).join(" ") }
    if (err.status === 422 && isConfigError(err.detail)) {
      return { kind: "fields", nodeId: err.detail.node_id, errors: errorsFromPydantic(err.detail.errors) }
    }
    const message = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)
    const nodeId = nodeNamedIn(message, graph)
    return nodeId ? { kind: "node", nodeId, message } : { kind: "column", message }
  }
  return { kind: "column", message: err instanceof Error ? err.message : String(err) }
}

/**
 * Fold one run's node states into what the column already knew. A run with
 * `targets` prunes the rest of the graph; a pruned or not-yet-started node
 * keeps its previous result.
 */
export function mergeResults(prev: Record<string, NodeState>, run: Record<string, NodeState>): Record<string, NodeState> {
  let out = prev
  for (const [id, s] of Object.entries(run)) {
    if (s.status === "pruned" || s.status === "pending" || prev[id] === s) continue
    if (out === prev) out = { ...prev }
    out[id] = s
  }
  // Unchanged input returns `prev` itself, so a state setter can bail out.
  return out
}

/** Last line of a Python traceback: the exception and its message. */
export function errorHeadline(traceback: string): string {
  const lines = traceback.trim().split("\n").filter((l) => l.trim())
  return lines[lines.length - 1]?.trim() ?? "Failed"
}

/** The artifact of a card's latest completed run, and of the run before it. */
export interface RunHistory {
  current?: string
  previous?: string
}

export interface Tracked {
  results: Record<string, NodeState>
  /** Per node id, in memory only: what "(was N)" compares against. */
  history: Record<string, RunHistory>
}

const completed = (s: NodeState | undefined) => (s?.status === "done" || s?.status === "cached") && typeof s.artifact_id === "string"

/**
 * `mergeResults`, plus the run history. Every newly completed node state is a
 * run of that card: its artifact becomes current and the old current becomes
 * previous. A cache hit counts too, so a rerun with unchanged settings
 * compares against itself and shows no "(was N)".
 */
export function foldRun(t: Tracked, run: Record<string, NodeState>): Tracked {
  const results = mergeResults(t.results, run)
  if (results === t.results) return t
  let history = t.history
  for (const [id, s] of Object.entries(results)) {
    if (s === t.results[id] || !completed(s)) continue
    if (history === t.history) history = { ...t.history }
    history[id] = { current: s.artifact_id, previous: t.history[id]?.current }
  }
  return { results, history }
}
