/**
 * The pure half of `useRun`: fold a run's event stream into state.
 *
 * Kept free of React and EventSource so the stream semantics are testable on
 * their own. Two rules the server imposes:
 *
 * - `stream_end` is the only terminal event. A sweep emits one
 *   `run_started ... run_finished` block per variant, so `run_finished` means
 *   "one variant done", never "stream done".
 * - Node ids repeat across sweep variants, so node state is grouped under the
 *   most recent `variant_started`. A plain run is a single variant with
 *   `index: null`.
 */

import type { RunEvent, RunSnapshot, RunStatus, Variant } from "./types"

export type NodeStatus =
  | "pending" // selected, not started
  | "pruned" // not selected by `targets`
  | "running"
  | "done" // executed fresh
  | "cached" // cache hit
  | "failed"
  | "skipped" // failed ancestor, or cancelled

export interface NodeState {
  id: string
  status: NodeStatus
  transform?: string
  artifact_id?: string
  cache_hit?: boolean
  duration_ms?: number
  error?: string
}

export interface VariantState {
  /** Sweep variant index; `null` for a plain run. */
  index: number | null
  variant?: Variant
  /** Topological order from `run_started`. */
  order: string[]
  nodes: Record<string, NodeState>
  ok?: boolean
}

export interface RunState {
  status: RunStatus | "idle"
  ok: boolean | null
  variants: VariantState[]
  warnings: string[]
  /** A crashed run (`run_error`), not a failed node. */
  error: string | null
  /** True once `stream_end` arrives. The stream may be closed only then. */
  closed: boolean
  /** Highest SSE `id` applied, so a replayed stream can be de-duplicated. */
  lastSeq: number
}

export const initialRunState: RunState = {
  status: "idle",
  ok: null,
  variants: [],
  warnings: [],
  error: null,
  closed: false,
  lastSeq: -1,
}

export type RunAction =
  | { type: "event"; event: RunEvent; seq?: number }
  | { type: "snapshot"; snapshot: RunSnapshot }
  | { type: "reset" }

function withCurrent(state: RunState, update: (v: VariantState) => VariantState): RunState {
  const variants = state.variants.length
    ? state.variants
    : [{ index: null, order: [], nodes: {} }]
  const last = variants.length - 1
  return { ...state, variants: [...variants.slice(0, last), update(variants[last])] }
}

function patchNode(state: RunState, id: string, patch: Partial<NodeState>): RunState {
  return withCurrent(state, (v) => ({
    ...v,
    nodes: { ...v.nodes, [id]: { ...(v.nodes[id] ?? { id, status: "pending" }), ...patch } },
  }))
}

function applyEvent(prev: RunState, e: RunEvent): RunState {
  const state: RunState = prev.status === "idle" ? { ...prev, status: "running" } : prev

  switch (e.event) {
    case "variant_started":
      return {
        ...state,
        variants: [...state.variants, { index: e.index, variant: e.variant, order: [], nodes: {} }],
      }
    case "variant_finished":
      return withCurrent(state, (v) => ({ ...v, ok: e.ok }))
    case "run_started": {
      const selected = new Set(e.selected ?? e.nodes)
      // A plain run has no `variant_started`; a second `run_started` without
      // one (should never happen) still gets its own group rather than
      // overwriting the first.
      const needsGroup =
        state.variants.length === 0 ||
        (state.variants[state.variants.length - 1].order.length > 0 &&
          state.variants[state.variants.length - 1].index === null)
      const base = needsGroup
        ? { ...state, variants: [...state.variants, { index: null, order: [], nodes: {} }] }
        : state
      return withCurrent(base, (v) => ({
        ...v,
        order: [...e.nodes],
        nodes: Object.fromEntries(
          e.nodes.map((id) => [id, { id, status: selected.has(id) ? "pending" : "pruned" }]),
        ),
      }))
    }
    case "node_started":
      return patchNode(state, e.node_id, {
        status: "running",
        transform: e.transform,
        artifact_id: e.artifact_id,
      })
    case "node_finished":
      return patchNode(state, e.node_id, {
        status: e.cache_hit ? "cached" : "done",
        artifact_id: e.artifact_id,
        cache_hit: e.cache_hit,
        duration_ms: e.duration_ms,
      })
    case "node_failed":
      return patchNode(state, e.node_id, { status: "failed", error: e.error })
    case "node_skipped":
      return patchNode(state, e.node_id, { status: "skipped" })
    case "run_cancelled":
      return (e.skipped ?? []).reduce((s, id) => patchNode(s, id, { status: "skipped" }), state)
    case "run_finished":
      return withCurrent(state, (v) => ({ ...v, ok: e.ok }))
    case "warning":
      return { ...state, warnings: [...state.warnings, e.message] }
    case "run_error":
      return { ...state, error: e.error }
    case "stream_end":
      return { ...state, status: e.status, ok: e.ok, closed: true }
    default:
      // A newer server may add events. Ignore them rather than crash the UI.
      return prev
  }
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "reset":
      return initialRunState
    case "snapshot": {
      const rebuilt = reduceEvents(action.snapshot.events)
      return {
        ...rebuilt,
        status: action.snapshot.status,
        ok: action.snapshot.ok,
        lastSeq: action.snapshot.last_event_id,
        closed: rebuilt.closed || action.snapshot.status !== "running",
      }
    }
    case "event": {
      if (action.seq !== undefined && action.seq <= state.lastSeq) return state
      const next = applyEvent(state, action.event)
      return action.seq === undefined ? next : { ...next, lastSeq: action.seq }
    }
  }
}

/** Fold a whole event log, as a snapshot or a test would. */
export function reduceEvents(events: RunEvent[]): RunState {
  return events.reduce<RunState>(
    (s, event, seq) => runReducer(s, { type: "event", event, seq }),
    initialRunState,
  )
}
