import { useEffect, useState } from "react"

import type { ArtifactType, Stage } from "@/api/types"
import { loadPayload } from "@/api/useArtifact"

import { outcomeFor, type Outcome } from "./outcome"

/**
 * The outcome of one artifact, for the card's summary row and its "What it
 * did" block. Both call this with the same id; `loadPayload` keeps one fetch
 * per artifact for the session, so the payload is read once.
 */

export type OutcomeState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; outcome: Outcome | null }

export function useOutcome(stage: Stage, type: ArtifactType | undefined, artifactId: string | undefined): OutcomeState | null {
  const [state, setState] = useState<{ id: string; value: OutcomeState } | null>(null)

  useEffect(() => {
    if (!artifactId) return
    let live = true
    loadPayload(artifactId).then(
      (data) => live && setState({ id: artifactId, value: { kind: "ready", outcome: outcomeFor(stage, type, data) } }),
      () => live && setState({ id: artifactId, value: { kind: "error" } }),
    )
    return () => {
      live = false
    }
  }, [stage, type, artifactId])

  if (!artifactId) return null
  return state?.id === artifactId ? state.value : { kind: "loading" }
}
