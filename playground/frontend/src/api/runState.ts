/**
 * The pure half of `useRun`: fold a run's event stream into state.
 *
 * Kept free of React and EventSource so the stream semantics are testable on
 * their own. Two rules the server imposes:
 *
 * - `stream_end` is the only terminal event. A comparison emits one
 *   `run_started ... run_finished` block per variant, so `run_finished` means
 *   "one variant done", never "stream done".
 * - Node ids repeat across a comparison's variants, so node state is grouped
 *   by the `variant` each event carries. A plain run is a single group with
 *   `index: null`.
 * - A /api/v2 event names Pandion's step, and `cardEvent` turns it into the
 *   card's id first. A page that knows its column passes `cardOf`, so a
 *   stacked step (`clean.2`) is the card at that place, whatever its id. A comparison's event carries `variant` (from 1) and goes
 *   in that variant's group; an evaluation's carries `question` and goes in
 *   that question's group, in order of first appearance.
 */

import { cardOfStep } from "@/state/config"

import type { RunEvent, RunSnapshot, RunStatus } from "./types"

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
  /**
   * A step that runs once per document (source to enrich), each document's own
   * state, by the name the run gives the document. The node's own fields are
   * then all of them together: running while one runs, failed when one failed.
   */
  documents?: Record<string, DocNodeState>
}

/** One document's run of a step. */
export type DocNodeState = Omit<NodeState, "id" | "documents">

export interface VariantState {
  /** The comparison variant's index, from 0; `null` for a plain run. */
  index: number | null
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
  /** A question-writing run's progress, from its latest `part_finished`; null before the first. */
  parts: { number: number; total: number } | null
  /** What the run returned, from `GET /api/v2/runs/{id}` once the stream ended. */
  result: unknown
  /** True when that read failed twice, so a page can say the result could not be read rather than show nothing. */
  resultFailed: boolean
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
  parts: null,
  result: null,
  resultFailed: false,
}

/** The card a Pandion step is drawn as, or null when the column has none for it. */
export type CardOf = (step: string) => string | null

export type RunAction =
  | { type: "event"; event: RunEvent; seq?: number; cardOf?: CardOf }
  | { type: "snapshot"; snapshot: RunSnapshot; cardOf?: CardOf }
  | { type: "reset" }
  | { type: "result"; result: unknown }
  | { type: "result_failed" }

function withCurrent(state: RunState, update: (v: VariantState) => VariantState): RunState {
  const variants = state.variants.length
    ? state.variants
    : [{ index: null, order: [], nodes: {} }]
  const last = variants.length - 1
  return { ...state, variants: [...variants.slice(0, last), update(variants[last])] }
}

function patchNode(state: RunState, id: string, patch: Partial<NodeState>, document?: string): RunState {
  return withCurrent(state, (v) => {
    const node = { ...(v.nodes[id] ?? { id, status: "pending" as NodeStatus }), ...patch }
    if (document === undefined) return { ...v, nodes: { ...v.nodes, [id]: node } }
    const docs = { ...node.documents, [document]: { ...(node.documents?.[document] ?? { status: "pending" as NodeStatus }), ...patch } }
    return { ...v, nodes: { ...v.nodes, [id]: { ...node, ...together(docs), documents: docs } } }
  })
}

/** A step's documents' states as the step's own: running while one runs, failed when one failed, cached when all were. */
function together(docs: Record<string, DocNodeState>): Pick<NodeState, "status" | "error"> {
  const all = Object.values(docs)
  const failed = all.find((d) => d.status === "failed")
  if (all.some((d) => d.status === "running")) return { status: "running" }
  if (failed) return { status: "failed", error: failed.error }
  if (all.length && all.every((d) => d.status === "cached")) return { status: "cached" }
  if (all.length && all.every((d) => d.status === "done" || d.status === "cached")) return { status: "done" }
  if (all.some((d) => d.status === "skipped")) return { status: "skipped" }
  return { status: all[0]?.status ?? "pending" }
}

/** Every document a step will run is known at the start, waiting, so a count is whole from the first event. */
function seedDocuments(nodes: Record<string, NodeState>, named: { node: string; document: string }[] = []): Record<string, NodeState> {
  const out = { ...nodes }
  for (const { node, document } of named) {
    const n = out[node]
    if (!n || n.documents?.[document]) continue
    out[node] = { ...n, documents: { ...n.documents, [document]: { status: "pending" } } }
  }
  return out
}

/** The document a /api/v2 event names, for a step that runs once per document. */
const documentOf = (e: RunEvent): string | undefined => {
  const d = (e as { document?: unknown }).document
  return typeof d === "string" && d ? d : undefined
}

type Named = { step?: unknown; steps?: unknown; selected_steps?: unknown; skipped_steps?: unknown }

/** A step with no card in the column keeps its step name, so it lands on no card. */
const cardFor = (step: string, cardOf: CardOf) => cardOf(step) ?? step

/** Each card once: a run over several documents names `parse` once per document. */
const cards = (xs: unknown, cardOf: CardOf): string[] | undefined =>
  Array.isArray(xs) ? [...new Set(xs.map((s) => cardFor(String((s as { step?: unknown } | null)?.step ?? ""), cardOf)))] : undefined

/**
 * A /api/v2 event names Pandion's step (`clean.1`, `search`); the column names
 * cards (`clean_1`, `retrieve`). An event from an old route has no `step` and
 * comes back as it is.
 */
export function cardEvent(e: RunEvent, cardOf: CardOf = cardOfStep): RunEvent {
  const n = e as RunEvent & Named
  if (n.event === "run_started" && Array.isArray(n.steps)) {
    const nodes = cards(n.steps, cardOf)!
    const named = ((n.selected_steps ?? n.steps) as { step?: unknown; document?: unknown }[]).flatMap((s) =>
      typeof s?.document === "string" && s.document ? [{ node: cardFor(String(s.step ?? ""), cardOf), document: s.document }] : [],
    )
    return { ...n, nodes, selected: cards(n.selected_steps, cardOf) ?? nodes, documents: named } as RunEvent
  }
  if (n.event === "run_cancelled" && Array.isArray(n.skipped_steps)) return { ...n, skipped: cards(n.skipped_steps, cardOf)! } as RunEvent
  if (typeof n.step === "string" && "node_id" in n) return { ...n, node_id: cardFor(n.step, cardOf) } as RunEvent
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
    case "run_started": {
      const selected = new Set(e.selected ?? e.nodes)
      // A second `run_started` with no group of its own (should never happen)
      // still gets its own group rather than overwriting the first. A /api/v2
      // run may start twice in one group: Pandion's ask runs the index, then
      // the search, so its second `run_started` merges into the group.
      const fromV2 = Array.isArray((e as { steps?: unknown }).steps)
      const last = state.variants[state.variants.length - 1]
      const needsGroup = state.variants.length === 0 || (!fromV2 && last.order.length > 0 && last.index === null)
      const base = needsGroup ? { ...state, variants: [...state.variants, { index: null, order: [], nodes: {} }] } : state
      return withCurrent(base, (v) => ({
        ...v,
        order: [...v.order, ...e.nodes.filter((id) => !v.order.includes(id))],
        nodes: seedDocuments(
          {
            ...v.nodes,
            ...Object.fromEntries(
              e.nodes.filter((id) => !(id in v.nodes)).map((id) => [id, { id, status: selected.has(id) ? "pending" : "pruned" } as NodeState]),
            ),
          },
          (e as { documents?: { node: string; document: string }[] }).documents,
        ),
      }))
    }
    case "question_finished":
      return { ...state, questions: { ...state.questions, [e.question]: { found: e.found, error: e.error, number: e.number } } }
    case "part_finished":
      return { ...state, parts: { number: e.number, total: e.total } }
    case "node_started":
      return patchNode(
        state,
        e.node_id,
        {
          status: "running",
          started_at: e.ts,
          transform: e.transform,
          artifact_id: e.artifact_id,
        },
        documentOf(e),
      )
    case "node_finished":
      return patchNode(
        state,
        e.node_id,
        {
          status: e.cache_hit ? "cached" : "done",
          artifact_id: e.artifact_id,
          cache_hit: e.cache_hit,
          duration_ms: e.duration_ms,
        },
        documentOf(e),
      )
    case "node_failed":
      return patchNode(state, e.node_id, { status: "failed", error: e.error }, documentOf(e))
    case "node_skipped":
      return patchNode(state, e.node_id, { status: "skipped" }, documentOf(e))
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
      const rebuilt = reduceEvents(action.snapshot.events, action.cardOf)
      return {
        ...rebuilt,
        status: action.snapshot.status,
        ok: action.snapshot.ok,
        lastSeq: action.snapshot.last_event_id,
        closed: rebuilt.closed || action.snapshot.status !== "running",
        result: action.snapshot.result ?? null,
        resultFailed: false,
      }
    }
    case "event": {
      if (action.seq !== undefined && action.seq <= state.lastSeq) return state
      const event = cardEvent(action.event, action.cardOf)
      const next = applyEvent(inGroup(state, event), event)
      return action.seq === undefined ? next : { ...next, lastSeq: action.seq }
    }
    case "result":
      return { ...state, result: action.result, resultFailed: false }
    case "result_failed":
      return { ...state, resultFailed: true }
  }
}

/** Fold a whole event log, as a snapshot or a test would. */
export function reduceEvents(events: RunEvent[], cardOf?: CardOf): RunState {
  return events.reduce<RunState>(
    (s, event, seq) => runReducer(s, { type: "event", event, seq, cardOf }),
    initialRunState,
  )
}

/**
 * The name a run gives a document (pandion-api's `safe_name`): its filename,
 * or, when the server could not keep the name's suffix, the filename with
 * every dot as `_`. When the server kept no name for the file at all, the run
 * names it as it is stored, `<sha><suffix>`, so a known `sha` matches that too.
 */
export function runsAs(filename: string, name: string, sha?: string): boolean {
  return name === filename || name === filename.replaceAll(".", "_") || (Boolean(sha) && (name === sha || name.startsWith(`${sha}.`)))
}

/**
 * Every node as one document's run shows it: a step that ran once per
 * document takes that document's own status, error, result and timing, so the
 * card shows that document. `documents` still holds every document's state,
 * for the counts. `filename` null, or a node with no run for it, leaves the node as it is.
 */
export function forDocument(results: Record<string, NodeState>, filename: string | null, sha?: string): Record<string, NodeState> {
  if (filename === null) return results
  let out = results
  for (const [id, node] of Object.entries(results)) {
    const name = node.documents ? Object.keys(node.documents).find((n) => runsAs(filename, n, sha)) : undefined
    if (!name) continue
    const own = node.documents![name]
    if (out === results) out = { ...results }
    out[id] = { ...node, status: own.status, error: own.error, artifact_id: own.artifact_id, cache_hit: own.cache_hit, duration_ms: own.duration_ms, started_at: own.started_at }
  }
  return out
}

/** How many of a step's documents are done, running, waiting, skipped or failed, and who failed. */
export function docCounts(node: NodeState) {
  const c = { total: 0, done: 0, running: 0, waiting: 0, skipped: 0, failed: 0, failedNames: [] as string[] }
  for (const [name, d] of Object.entries(node.documents ?? {})) {
    c.total++
    if (d.status === "done" || d.status === "cached") c.done++
    else if (d.status === "running") c.running++
    else if (d.status === "failed") {
      c.failed++
      c.failedNames.push(name)
    } else if (d.status === "skipped") c.skipped++
    else c.waiting++
  }
  return c
}

/** One document's state across every step: failed, else running, else done when every step is, else skipped if one was, else pending. */
export function docStatusOf(results: Record<string, NodeState>, filename: string, sha?: string): NodeStatus | undefined {
  const all: NodeStatus[] = []
  for (const node of Object.values(results)) {
    const name = node.documents ? Object.keys(node.documents).find((n) => runsAs(filename, n, sha)) : undefined
    if (name) all.push(node.documents![name].status)
  }
  if (!all.length) return undefined
  if (all.includes("failed")) return "failed"
  if (all.includes("running")) return "running"
  if (all.every((s) => s === "done" || s === "cached")) return "done"
  return all.includes("skipped") ? "skipped" : "pending"
}
