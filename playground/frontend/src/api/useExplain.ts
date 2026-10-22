import { useEffect, useRef, useState } from "react"

import type { FieldErrors } from "@/components/fields/schema"
import { detailSentences, problemDetails } from "@/state/pipeline"

import { api, ApiError } from "./client"
import type { Explanation, GraphNode, StageInfo } from "./types"
import { v2 } from "./v2"

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
  /** A refused setting's message, under that setting, when Pandion's sentence names one. */
  fields?: FieldErrors
}

export const EXPLAIN_DEBOUNCE_MS = 200

const keyOf = (n: GraphNode) => JSON.stringify([n.stage, n.transform, n.config])

function isExplanation(x: unknown): x is Explanation {
  return typeof x === "object" && x !== null && typeof (x as Explanation).settings === "string"
}

/** A 422's `{problems}`, Pandion's sentences, or null for any other shape. */
function problemsOf(detail: unknown): string[] | null {
  const problems = (detail as { problems?: unknown } | null)?.problems
  return Array.isArray(problems) && problems.every((p) => typeof p === "string") ? problems : null
}

const refused = (warning: string): Explanation => ({ settings: "", tradeoff: null, warning, blocking: true })

/**
 * What a card shows when the server refuses to explain it, or null to keep
 * what is shown (a server error or the network proves nothing about the
 * settings). Run stays disabled for every refusal: the run would be refused too.
 */
export function refusal(err: unknown, node: GraphNode): ExplainState | null {
  if (!(err instanceof ApiError)) return null
  if (err.status === 404) return { data: refused(`This server does not have ${node.transform}. Pick another.`) }
  if (err.status !== 422) return null
  const problems = problemsOf(err.detail)
  if (!problems) {
    const said = detailSentences(err.detail)
    return { data: refused(said ? `This server refused these settings. ${said}` : "This server refused these settings.") }
  }
  // Under each setting when Pandion placed every problem on a setting of this strategy.
  const placed = problemDetails(err.detail)
  if (placed?.every((p) => p.use === node.transform && p.settings.length > 0)) {
    const fields: FieldErrors = {}
    for (const p of placed) for (const { field, message } of p.settings) (fields[field] ??= []).push(message)
    const one = Object.keys(fields).length === 1
    return { data: refused(one ? "Fix the setting marked below." : "Fix the settings marked below."), fields }
  }
  return { data: refused(problems.join(" ")) }
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
        v2.explain({ stage: node.stage, use: node.transform, settings: node.config }, ctrl.signal).then(
          (res) => {
            if (!current() || !isExplanation(res)) return
            setState((s) => ({ ...s, [node.id]: { data: res } }))
          },
          (err: unknown) => {
            if (!current()) return
            const shown = refusal(err, node)
            if (shown) setState((s) => ({ ...s, [node.id]: shown }))
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
