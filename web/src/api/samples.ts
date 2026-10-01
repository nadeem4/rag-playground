import { useEffect, useState } from "react"

import { api } from "./client"
import type { SampleCard, Source } from "./types"

/**
 * The bundled samples, shared by every place that lists or loads one (F2):
 * the Load card (`FirstRun`) and the file picker's Samples group
 * (`SourcePicker`). One fetch, one error message, instead of three.
 */
export interface SamplesState {
  /** Null until the list arrives, or when it could not be read. */
  samples: SampleCard[] | null
  /** Set when the list could not be read, so a caller need not stay silent. */
  error: string | null
}

export function useSamples(): SamplesState {
  const [state, setState] = useState<SamplesState>({ samples: null, error: null })
  useEffect(() => {
    let live = true
    api.samples().then(
      (s) => live && setState({ samples: s, error: null }),
      (err: unknown) => live && setState({ samples: null, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [])
  return state
}

/** `POST /api/sources/sample`: load one bundled sample by name. */
export function loadSample(name: string): Promise<Source> {
  return api.sampleSource(name)
}
