/**
 * Follow one run (or sweep) over SSE: `/api/runs/{id}/events`.
 *
 * - One EventSource per run id, even under React StrictMode, which mounts,
 *   unmounts and re-mounts every effect in development. The cleanup defers
 *   its close by a tick and the re-mount cancels it, so the stream opened on
 *   the first mount is the one kept. Without this, dev opens two streams and
 *   every event is applied twice.
 * - Every frame arrives through `onmessage` (the server sends no `event:`
 *   field) and is switched on `payload.event` by the reducer.
 * - The stream is closed on `stream_end` only. See runState.ts.
 * - On a dropped connection: fetch the snapshot (`GET /api/runs/{id}`),
 *   rebuild state from its event log, then reopen with
 *   `?last_event_id=<snapshot.last_event_id>`. EventSource cannot set a
 *   `Last-Event-ID` header on a fresh connection, so the query parameter
 *   carries it. The reducer still skips any id it has already applied, as a
 *   safety net.
 */

import { useEffect, useReducer, useRef } from "react"

import { api } from "./client"
import { initialRunState, runReducer, type NodeState, type RunAction, type RunState } from "./runState"
import type { RunEvent } from "./types"

const RETRY_MS = [500, 1000, 2000, 5000]

/** Stable, so `nodes` keeps its identity across renders before any event. */
const NO_NODES: Record<string, NodeState> = Object.freeze({}) as Record<string, NodeState>

interface Connection {
  runId: string
  es: EventSource | null
  dead: boolean
  attempts: number
  /** Highest event id seen, so a reopened stream resumes after it. */
  lastSeq: number
  closeTimer?: ReturnType<typeof setTimeout>
  retryTimer?: ReturnType<typeof setTimeout>
}

export interface UseRun extends RunState {
  /** The current (latest) variant's nodes; a plain run has exactly one. */
  nodes: Record<string, NodeState>
}

function shutdown(c: Connection) {
  c.dead = true
  clearTimeout(c.closeTimer)
  clearTimeout(c.retryTimer)
  c.es?.close()
  c.es = null
}

function connect(c: Connection, dispatch: (a: RunAction) => void) {
  if (c.dead) return
  const es = new EventSource(api.eventsUrl(c.runId, c.lastSeq >= 0 ? c.lastSeq : undefined))
  c.es = es

  es.onopen = () => {
    c.attempts = 0
  }

  es.onmessage = (msg: MessageEvent<string>) => {
    if (c.dead || c.es !== es) return
    let event: RunEvent
    try {
      event = JSON.parse(msg.data) as RunEvent
    } catch {
      return // a malformed frame is not worth killing the stream over
    }
    if (!event || typeof event !== "object" || typeof event.event !== "string") return
    const seq = msg.lastEventId === "" ? undefined : Number(msg.lastEventId)
    if (seq !== undefined && Number.isFinite(seq)) c.lastSeq = Math.max(c.lastSeq, seq)
    dispatch({ type: "event", event, seq: Number.isFinite(seq) ? seq : undefined })
    if (event.event === "stream_end") {
      es.close()
      c.es = null
    }
  }

  es.onerror = () => {
    if (c.dead || c.es !== es) return
    es.close()
    c.es = null
    void resync(c, dispatch)
  }
}

async function resync(c: Connection, dispatch: (a: RunAction) => void) {
  try {
    const snapshot = await api.run(c.runId)
    if (c.dead) return
    dispatch({ type: "snapshot", snapshot })
    c.lastSeq = Math.max(c.lastSeq, snapshot.last_event_id)
    if (snapshot.status === "running") connect(c, dispatch)
  } catch {
    if (c.dead) return
    const delay = RETRY_MS[Math.min(c.attempts, RETRY_MS.length - 1)]
    c.attempts += 1
    c.retryTimer = setTimeout(() => void resync(c, dispatch), delay)
  }
}

export function useRun(runId: string | null): UseRun {
  const [state, dispatch] = useReducer(runReducer, initialRunState)
  const conn = useRef<Connection | null>(null)

  useEffect(() => {
    if (!runId) {
      dispatch({ type: "reset" })
      return
    }

    const current = conn.current
    if (current && current.runId === runId && !current.dead) {
      // StrictMode re-mount: keep the stream the first mount opened.
      clearTimeout(current.closeTimer)
      current.closeTimer = undefined
    } else {
      if (current) shutdown(current)
      dispatch({ type: "reset" })
      const c: Connection = { runId, es: null, dead: false, attempts: 0, lastSeq: -1 }
      conn.current = c
      connect(c, dispatch)
    }

    return () => {
      const c = conn.current
      if (!c) return
      c.closeTimer = setTimeout(() => {
        shutdown(c)
        if (conn.current === c) conn.current = null
      }, 0)
    }
  }, [runId])

  const latest = state.variants[state.variants.length - 1]
  return { ...state, nodes: latest?.nodes ?? NO_NODES }
}
