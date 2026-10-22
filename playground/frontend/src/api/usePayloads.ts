import { useEffect, useState } from "react"

import type { InspectorStatus } from "@/components/inspectors/status"

import type { ChunkStats } from "./types"
import { loadPayload } from "./useArtifact"
import { v2 } from "./v2"

/**
 * Payloads by artifact id, loaded once each. Artifacts are immutable, so
 * nothing is refetched. Used by the pages that show many artifacts at once:
 * Compare, a column per variant, and Evaluate, a row per question.
 */
export function usePayloads(ids: (string | undefined)[]): (id: string | undefined) => { status: InspectorStatus; data?: unknown } {
  const [data, setData] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = ids.filter(Boolean).join(",")
  useEffect(() => {
    let live = true
    for (const id of new Set(key.split(",").filter(Boolean))) {
      loadPayload(id).then(
        (d) => live && setData((m) => (id in m ? m : { ...m, [id]: d })),
        (e: unknown) => live && setErrors((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) })),
      )
    }
    return () => {
      live = false
    }
  }, [key])
  return (id) => {
    if (!id) return { status: { kind: "ready" } }
    if (id in data) return { status: { kind: "ready" }, data: data[id] }
    if (id in errors) return { status: { kind: "error", message: errors[id] } }
    return { status: { kind: "loading" } }
  }
}

/**
 * The totals of each list of chunk sets (one recipe's, one per document), as
 * Pandion sums them up (`POST /api/v2/chunk-stats`), by the list's ids joined
 * with commas. Loaded once each; a list with fewer than two ids is not asked.
 */
export function useChunkTotals(lists: string[][]): (ids: string[]) => ChunkStats | undefined {
  const [data, setData] = useState<Record<string, ChunkStats>>({})
  const key = lists.filter((l) => l.length > 1).map((l) => l.join(",")).join(";")
  useEffect(() => {
    let live = true
    for (const joined of new Set(key.split(";").filter(Boolean))) {
      v2.chunkStats(joined.split(",")).then(
        (s) => live && setData((m) => (joined in m ? m : { ...m, [joined]: s })),
        () => undefined,
      )
    }
    return () => {
      live = false
    }
  }, [key])
  return (ids) => data[ids.join(",")]
}
