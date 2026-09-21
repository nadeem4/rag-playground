import { useCallback, useEffect, useState } from "react"

import { api } from "./client"
import type { Registry } from "./types"

/** `GET /api/registry`, once per page, with a retry for the error screen. */
export type RegistryState =
  | { kind: "loading" }
  | { kind: "error"; message: string; retry: () => void }
  | { kind: "ready"; registry: Registry }

export function useRegistry(): RegistryState {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ attempt: number; value: Exclude<RegistryState, { kind: "error" }> | { kind: "error"; message: string } }>({
    attempt: -1,
    value: { kind: "loading" },
  })
  const retry = useCallback(() => setAttempt((a) => a + 1), [])

  useEffect(() => {
    let live = true
    api.registry().then(
      (registry) => live && setState({ attempt, value: { kind: "ready", registry } }),
      (err: unknown) => live && setState({ attempt, value: { kind: "error", message: err instanceof Error ? err.message : String(err) } }),
    )
    return () => {
      live = false
    }
  }, [attempt])

  if (state.attempt !== attempt) return { kind: "loading" }
  return state.value.kind === "error" ? { ...state.value, retry } : state.value
}
