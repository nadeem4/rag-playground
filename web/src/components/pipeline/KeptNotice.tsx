import { useState } from "react"

import { Button } from "@/components/ui/button"
import { keptOldPipeline, markKeptSeen } from "@/state/working"

/**
 * One line on Build, once: the pipeline this browser had open was made by an
 * older version and could not be converted. It is kept, never deleted.
 */
export function KeptNotice({ onDismiss }: { onDismiss?: () => void }) {
  const [kept, setKept] = useState(() => keptOldPipeline())
  if (!kept || kept.seen) return null
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 text-sm text-fg-muted">
      <span>
        The pipeline you had open was made by an older version and could not be opened here. {kept.problem} It is still kept in this browser, and
        Build opened on the Starter.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          markKeptSeen()
          setKept(keptOldPipeline())
          onDismiss?.()
        }}
      >
        Got it
      </Button>
    </p>
  )
}
