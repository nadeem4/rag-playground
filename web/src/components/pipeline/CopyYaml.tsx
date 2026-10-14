import { useState } from "react"

import { v2 } from "@/api/v2"
import { Button } from "@/components/ui/button"
import { graphToConfig } from "@/state/config"
import type { PipelineGraph } from "@/state/graph"

const COPIED = "Copied. Save it as pipeline.yaml and run: pandion index pipeline.yaml your.pdf"
const REFUSED = "The browser could not copy to the clipboard. Allow clipboard access for this site and try again."

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
      setLine(err instanceof Error ? err.message : String(err))
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
