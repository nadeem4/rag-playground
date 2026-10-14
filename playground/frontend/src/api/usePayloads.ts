import { useEffect, useState } from "react"

import type { InspectorStatus } from "@/components/inspectors/status"

import { loadPayload } from "./useArtifact"

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
