import { useEffect, useState } from "react"

import type { InspectorStatus } from "@/components/inspectors/status"

import { api } from "./client"
import type { ArtifactMeta } from "./types"

/**
 * Load an artifact's payload. Artifacts are content-addressed and immutable,
 * so a payload fetched once is kept for the session and never refetched.
 */

const cache = new Map<string, Promise<unknown>>()

/** The payload, fetched once per session. Also used outside React (Build's sweep preset). */
export function loadPayload(id: string): Promise<unknown> {
  return fetchPayload(id)
}

function fetchPayload(id: string): Promise<unknown> {
  let p = cache.get(id)
  if (!p) {
    p = api.artifactPayload(id)
    // A failed fetch is not cached: the next request tries again.
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

export interface ArtifactState {
  status: InspectorStatus
  data?: unknown
}

const IDLE: ArtifactState = { status: { kind: "ready" } }

export function useArtifactPayload(id: string | undefined): ArtifactState {
  const [state, setState] = useState<{ id?: string; value: ArtifactState }>({ value: IDLE })

  useEffect(() => {
    if (!id) return
    let live = true
    setState({ id, value: { status: { kind: "loading" } } })
    fetchPayload(id).then(
      (data) => live && setState({ id, value: { status: { kind: "ready" }, data } }),
      (err: unknown) =>
        live && setState({ id, value: { status: { kind: "error", message: err instanceof Error ? err.message : String(err) } } }),
    )
    return () => {
      live = false
    }
  }, [id])

  if (!id) return IDLE
  // Until the effect runs for a new id, report loading rather than old data.
  return state.id === id ? state.value : { status: { kind: "loading" } }
}

const metaCache = new Map<string, Promise<ArtifactMeta>>()

/** `GET /api/artifacts/{id}`, once per session: meta is as immutable as the payload. */
export function loadMeta(id: string): Promise<ArtifactMeta> {
  let p = metaCache.get(id)
  if (!p) {
    p = api.artifact(id)
    p.catch(() => metaCache.delete(id))
    metaCache.set(id, p)
  }
  return p
}
