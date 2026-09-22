import { useEffect, useRef, useState } from "react"

import { errorsFromPydantic, type PydanticError } from "@/components/fields/schema"

import { api, ApiError } from "./client"
import type { Explanation, GraphNode, StageInfo } from "./types"

/**
 * Plan I-11 / I-12 in the browser: what each stage is for (fetched once per
 * session) and what each card's transform will do with its CURRENT settings
 * (refetched as the settings change, debounced, stale answers dropped).
 */

// ------------------------------------------------------------------ stages --

let stagesOnce: Promise<StageInfo> | null = null

/** `GET /api/stages`, once per session. A failure is not cached. */
export function loadStages(): Promise<StageInfo> {
  if (!stagesOnce) {
    stagesOnce = api.stages().then((s) => (s && typeof s === "object" && !Array.isArray(s) ? s : {}))
    stagesOnce.catch(() => {
      stagesOnce = null
    })
  }
  return stagesOnce
}

/** For tests: forget the cached stage text. */
export function resetStagesCache(): void {
  stagesOnce = null
}

export function useStages(): StageInfo {
  const [stages, setStages] = useState<StageInfo>({})
  useEffect(() => {
    let live = true
    loadStages().then(
      (s) => live && setStages(s),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  return stages
}

// ----------------------------------------------------------------- explain --

export interface ExplainState {
  /** The last explanation received. Kept while a newer one loads: no empty flash. */
  data?: Explanation
  /** A 422: the config failed validation. The messages, one per line. */
  invalid?: string
}

export const EXPLAIN_DEBOUNCE_MS = 200

const keyOf = (n: GraphNode) => JSON.stringify([n.stage, n.transform, n.config])

function isExplanation(x: unknown): x is Explanation {
  return typeof x === "object" && x !== null && typeof (x as Explanation).settings === "string"
}

/** A 422's `{errors}` as readable lines: `chunk_size: Input should be ...`. */
export function invalidMessage(detail: unknown): string {
  const errors = (detail as { errors?: unknown })?.errors
  if (!Array.isArray(errors)) return typeof detail === "string" ? detail : "These settings are not valid."
  return Object.entries(errorsFromPydantic(errors as PydanticError[]))
    .flatMap(([field, msgs]) => msgs.map((m) => (field ? `${field}: ${m}` : m)))
    .join("\n")
}

interface Pending {
  key: string
  timer: number
  ctrl: AbortController
}

/**
 * One explanation per node, keyed by node id. Every node is explained, not
 * only the one whose pop-over is open: a card's inline warning must appear as
 * the user types. A node's first request goes out at once; a change to it
 * waits for the settings to settle, then aborts whatever is still in flight.
 */
export function useExplanations(nodes: readonly GraphNode[]): Record<string, ExplainState> {
  const [state, setState] = useState<Record<string, ExplainState>>({})
  const inflight = useRef(new Map<string, Pending>())
  const signature = nodes.map((n) => `${n.id}\u0000${keyOf(n)}`).join("\u0001")

  useEffect(() => {
    const map = inflight.current
    const present = new Set(nodes.map((n) => n.id))
    for (const [id, p] of map) {
      if (present.has(id)) continue
      window.clearTimeout(p.timer)
      p.ctrl.abort()
      map.delete(id)
    }
    for (const node of nodes) {
      const key = keyOf(node)
      const prev = map.get(node.id)
      if (prev?.key === key) continue
      if (prev) {
        window.clearTimeout(prev.timer)
        prev.ctrl.abort()
      }
      const ctrl = new AbortController()
      const current = () => map.get(node.id)?.ctrl === ctrl && !ctrl.signal.aborted
      const send = () => {
        api.explain({ stage: node.stage, transform: node.transform, config: node.config }, ctrl.signal).then(
          (res) => {
            if (!current() || !isExplanation(res)) return
            setState((s) => ({ ...s, [node.id]: { data: res } }))
          },
          (err: unknown) => {
            if (!current()) return
            if (err instanceof ApiError && err.status === 422) {
              const invalid = invalidMessage(err.detail)
              setState((s) => ({ ...s, [node.id]: { data: s[node.id]?.data, invalid } }))
            }
            // Anything else (a 404 on an older server, the network): keep what is shown.
          },
        )
      }
      const timer = window.setTimeout(send, prev ? EXPLAIN_DEBOUNCE_MS : 0)
      map.set(node.id, { key, timer, ctrl })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  useEffect(() => {
    const map = inflight.current
    return () => {
      for (const p of map.values()) {
        window.clearTimeout(p.timer)
        p.ctrl.abort()
      }
      map.clear()
    }
  }, [])

  return state
}
