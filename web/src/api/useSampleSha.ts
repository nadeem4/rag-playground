import { useEffect, useState } from "react"

import { api } from "./client"

/**
 * The bundled sample document's fingerprint, which is the only document the
 * built-in question set describes. Evaluate compares it with the source on
 * Build to know whether those questions belong to the loaded document.
 *
 * `POST /api/sources/sample` is how every other page learns it, and it is
 * idempotent: it registers the bundled file if it is not registered already.
 * Null until it answers, and null if it cannot be read, in which case the page
 * says nothing rather than warning about a document it cannot identify.
 */
export function useSampleSha(): string | null {
  const [sha, setSha] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.sampleSource().then(
      (s) => live && setSha(s.sha),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return sha
}
