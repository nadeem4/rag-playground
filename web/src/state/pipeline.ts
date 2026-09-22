import { ApiError } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { RunRequest } from "@/api/types"
import { errorsFromPydantic, type FieldErrors, type PydanticError } from "@/components/fields/schema"

import type { PipelineGraph } from "./graph"

/**
 * The Build page's run plumbing, kept pure so it is testable without a
 * browser: the request a button sends, where a failure is shown, and how the
 * results of partial runs accumulate.
 */

/** `target` present: that card's Run (the server adds its ancestors). Absent: Run all. */
export function buildRunRequest(graph: PipelineGraph, opts: { target?: string; force?: boolean }): RunRequest {
  const req: RunRequest = { graph, force: Boolean(opts.force) }
  if (opts.target) req.targets = [opts.target]
  return req
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

/** The node a graph-validation message is about, if it names exactly one. */
function nodeNamedIn(message: string, graph: PipelineGraph): string | null {
  const ids = new Set(graph.nodes.map((n) => n.id))
  // "edge a->b...": the edge belongs to the node it feeds.
  const edge = /edge ([\w-]+)->([\w-]+)/.exec(message)
  if (edge && ids.has(edge[2])) return edge[2]
  const named = new Set(message.split(/[^\w-]+/).filter((tok) => ids.has(tok)))
  return named.size === 1 ? [...named][0] : null
}

/** Where on the page a failed `POST /api/runs` (or `/sweeps`) is shown. */
export function routeRunError(err: unknown, graph: PipelineGraph): RoutedError {
  if (err instanceof ApiError) {
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
