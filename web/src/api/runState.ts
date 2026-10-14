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
 * - A /api/v2 event names Pandion's step, and `cardEvent` turns it into the
 *   card's id first. A comparison's event carries `variant` (from 1) and goes
 *   in that variant's group; an evaluation's carries `question` and goes in
 *   that question's group, in order of first appearance.
 */

import { cardOfStep } from "@/state/config"

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
  /** `node_started` time, epoch seconds (the event's `ts`). */
  started_at?: number
}

export interface VariantState {
  /** Sweep variant index; `null` for a plain run. */
  index: number | null
  variant?: Variant
  /** The evaluation question this group's steps answered (/api/v2 only). */
  question?: string
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
  /** True while the run waits for its turn on the busy demo (`queued` until `unqueued`). */
  queued: boolean
  /** Highest SSE `id` applied, so a replayed stream can be de-duplicated. */
  lastSeq: number
  /** Each evaluation question's outcome, by id, from `question_finished`. */
  questions: Record<string, { found: boolean; error: string | null; number: number }>
  /** What the run returned, from `GET /api/v2/runs/{id}` once the stream ended. */
  result: unknown
}

/** What a page says while its run waits its turn on the busy demo. */
export const QUEUED_LINE = "The demo is busy with other learners. Your run starts in a moment."

export const initialRunState: RunState = {
  status: "idle",
  ok: null,
  variants: [],
  warnings: [],
  error: null,
  closed: false,
  queued: false,
  lastSeq: -1,
  questions: {},
  result: null,
}

export type RunAction =
  | { type: "event"; event: RunEvent; seq?: number }
  | { type: "snapshot"; snapshot: RunSnapshot }
  | { type: "reset" }
  | { type: "result"; result: unknown }

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

type Named = { step?: unknown; steps?: unknown; selected_steps?: unknown; skipped_steps?: unknown }

const cards = (xs: unknown): string[] | undefined =>
  Array.isArray(xs) ? xs.map((s) => cardOfStep(String((s as { step?: unknown } | null)?.step ?? ""))) : undefined

/**
 * A /api/v2 event names Pandion's step (`clean.1`, `search`); the column names
 * cards (`clean_1`, `retrieve`). An event from an old route has no `step` and
 * comes back as it is.
 */
export function cardEvent(e: RunEvent): RunEvent {
  const n = e as RunEvent & Named
  if (n.event === "run_started" && Array.isArray(n.steps)) {
    const nodes = cards(n.steps)!
    return { ...n, nodes, selected: cards(n.selected_steps) ?? nodes } as RunEvent
  }
  if (n.event === "run_cancelled" && Array.isArray(n.skipped_steps)) return { ...n, skipped: cards(n.skipped_steps)! } as RunEvent
  if (typeof n.step === "string" && "node_id" in n) return { ...n, node_id: cardOfStep(n.step) } as RunEvent
  return e
}

/** A comparison's event goes in its variant's group, an evaluation's in its question's. */
function inGroup(state: RunState, e: RunEvent): RunState {
  const tagged = e as RunEvent & { variant?: unknown; question?: unknown }
  const last = state.variants[state.variants.length - 1]
  if (typeof tagged.variant === "number") {
    const index = tagged.variant - 1
    if (last?.index === index) return state
    return { ...state, variants: [...state.variants, { index, order: [], nodes: {} }] }
  }
  if (typeof tagged.question === "string" && e.event !== "question_finished") {
    if (last?.question === tagged.question) return state
    const index = state.variants.filter((v) => v.question !== undefined).length
    return { ...state, variants: [...state.variants, { index, question: tagged.question, order: [], nodes: {} }] }
  }
  return state
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
      // A plain run on an old route has no `variant_started`; a second
      // `run_started` without one (should never happen) still gets its own
      // group rather than overwriting the first. A /api/v2 run may start twice
      // in one group: Pandion's ask runs the index, then the search, so its
      // second `run_started` merges into the group.
      const fromV2 = Array.isArray((e as { steps?: unknown }).steps)
      const last = state.variants[state.variants.length - 1]
      const needsGroup = state.variants.length === 0 || (!fromV2 && last.order.length > 0 && last.index === null)
      const base = needsGroup ? { ...state, variants: [...state.variants, { index: null, order: [], nodes: {} }] } : state
      return withCurrent(base, (v) => ({
        ...v,
        order: [...v.order, ...e.nodes.filter((id) => !v.order.includes(id))],
        nodes: {
          ...v.nodes,
          ...Object.fromEntries(
            e.nodes.filter((id) => !(id in v.nodes)).map((id) => [id, { id, status: selected.has(id) ? "pending" : "pruned" } as NodeState]),
          ),
        },
      }))
    }
    case "question_finished":
      return { ...state, questions: { ...state.questions, [e.question]: { found: e.found, error: e.error, number: e.number } } }
    case "node_started":
      return patchNode(state, e.node_id, {
        status: "running",
        started_at: e.ts,
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
    case "queued":
      return { ...state, queued: true }
    case "unqueued":
      return { ...state, queued: false }
    case "stream_end":
      return { ...state, status: e.status, ok: e.ok, closed: true, queued: false }
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
        result: action.snapshot.result ?? null,
      }
    }
    case "event": {
      if (action.seq !== undefined && action.seq <= state.lastSeq) return state
      const event = cardEvent(action.event)
      const next = applyEvent(inGroup(state, event), event)
      return action.seq === undefined ? next : { ...next, lastSeq: action.seq }
    }
    case "result":
      return { ...state, result: action.result }
  }
}

/** Fold a whole event log, as a snapshot or a test would. */
export function reduceEvents(events: RunEvent[]): RunState {
  return events.reduce<RunState>(
    (s, event, seq) => runReducer(s, { type: "event", event, seq }),
    initialRunState,
  )
}
