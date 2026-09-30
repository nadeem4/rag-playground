import { useEffect, useState } from "react"

import { api } from "./client"
import type { SampleCard } from "./types"

/** The bundled samples, once; null until they arrive or when they cannot be read. */
export function useSamples(): SampleCard[] | null {
  const [samples, setSamples] = useState<SampleCard[] | null>(null)
  useEffect(() => {
    let live = true
    api.samples().then(
      (s) => live && setSamples(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return samples
}
