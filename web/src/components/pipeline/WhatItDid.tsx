import { useEffect, useState } from "react"

import type { ArtifactType, Stage } from "@/api/types"
import { loadMeta, loadPayload } from "@/api/useArtifact"
import { cn } from "@/lib/utils"

import { outcomeFor, outcomeText } from "./outcome"

/**
 * The card's "What it did" block (option B): the outcome in one sentence,
 * "(was N)" against this card's previous run, and the plugin's note (plan
 * I-13). Muted when the settings changed since the run; the note is then
 * hidden, since it described a run the current settings would not repeat.
 */

export interface WhatItDidProps {
  stage: Stage
  type?: ArtifactType
  artifactId: string
  /** The artifact of this card's previous run, if any. */
  previousId?: string
  stale?: boolean
}

type Shown = { id: string; text: string | null; note: string | null } | { id: string; error: true }

export function WhatItDid({ stage, type, artifactId, previousId, stale }: WhatItDidProps) {
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    let live = true
    const previous = previousId && previousId !== artifactId ? loadPayload(previousId).catch(() => null) : Promise.resolve(null)
    const note = loadMeta(artifactId).then(
      (m) => (typeof m?.meta?.note === "string" && m.meta.note.trim() ? m.meta.note.trim() : null),
      () => null,
    )
    Promise.all([loadPayload(artifactId), previous, note]).then(
      ([data, before, n]) => {
        if (!live) return
        const now = outcomeFor(stage, type, data)
        const then = before === null ? null : outcomeFor(stage, type, before)
        setShown({ id: artifactId, text: now ? outcomeText(now, then?.headline) : null, note: n })
      },
      () => live && setShown({ id: artifactId, error: true }),
    )
    return () => {
      live = false
    }
  }, [stage, type, artifactId, previousId])

  if (!shown || shown.id !== artifactId) return null
  if ("error" in shown) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold">What it did</span>
        <span className="text-xs text-fg-muted">Could not read the output.</span>
      </div>
    )
  }
  if (!shown.text && !shown.note) return null
  return (
    <div className="flex flex-col gap-1" data-testid="what-it-did" data-stale={stale ? "" : undefined}>
      <span className="text-xs font-semibold">What it did</span>
      {shown.text ? <p className={cn("m-0 font-mono text-sm leading-[1.5] break-words", stale ? "text-fg-muted" : "text-fg")}>{shown.text}</p> : null}
      {shown.note && !stale ? <p className="m-0 text-sm leading-[1.5] text-fg">{shown.note}</p> : null}
    </div>
  )
}
