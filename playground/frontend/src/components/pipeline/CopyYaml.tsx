import { useState } from "react"

import { ApiError } from "@/api/client"
import { v2 } from "@/api/v2"
import { Button } from "@/components/ui/button"
import { graphToConfig } from "@/state/config"
import type { PipelineGraph } from "@/state/graph"

const COPIED = "Copied. Save it as pipeline.yaml and run: pandion index pipeline.yaml your.pdf"
const UNCHECKED = "Could not check the pipeline just now. Nothing was copied."
const REFUSED = "The browser could not copy to the clipboard. Allow clipboard access for this site and try again."

/** The sentence a refused request carries, or the plain fallback. A server error never shows its raw text. */
function sayError(err: unknown): string {
  if (err instanceof ApiError && err.status < 500) {
    if (typeof err.detail === "string" && err.detail) return err.detail
    const d = err.detail
    if (d && typeof d === "object" && "problems" in d && Array.isArray((d as { problems: unknown }).problems)) {
      return (d as { problems: unknown[] }).problems.map(String).join(" ")
    }
  }
  return UNCHECKED
}

/**
 * The pipeline on Build as a pipeline file Pandion reads, on the clipboard.
 * The server writes the file (POST /api/v2/pipelines/validate), so it is
 * exactly what Pandion's own to_yaml would give, and a pipeline with a
 * problem is never copied.
 */
export function CopyYaml({ graph }: { graph: PipelineGraph }) {
  const [line, setLine] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function copy() {
    setBusy(true)
    setLine(null)
    try {
      const c = graphToConfig(graph)
      if (!c.ok) {
        setLine(c.problem)
        return
      }
      const res = await v2.validate(c.pipeline.config)
      if (!res.ok) {
        setLine(res.problems.join(" "))
        return
      }
      try {
        await navigator.clipboard.writeText(res.yaml)
      } catch {
        setLine(REFUSED)
        return
      }
      setLine(COPIED)
    } catch (err) {
      setLine(sayError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void copy()}>
        Copy as YAML
      </Button>
      {line ? (
        <span role="status" className="text-xs text-fg-muted">
          {line}
        </span>
      ) : null}
    </span>
  )
}
