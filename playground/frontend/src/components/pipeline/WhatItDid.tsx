import { useEffect, useState } from "react"

import type { ArtifactType, Stage } from "@/api/types"
import { loadMeta, loadPayload } from "@/api/useArtifact"
import { cn } from "@/lib/utils"

import { outcomeFor, outcomeText, type Outcome } from "./outcome"
import { useOutcome } from "./useOutcome"

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
  /** True shows the plugin's note alone when there is one: the Ask panel, where the note already states the count. */
  preferNote?: boolean
}

/** A sentence in the reading face, with each number in it set in mono. */
export function MonoNumbers({ text }: { text: string }) {
  const parts = text.split(/(\d(?:[\d,.]*\d)?)/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}

type Extra = { id: string; before: Outcome | null; note: string | null }

export function WhatItDid({ stage, type, artifactId, previousId, stale, preferNote = false }: WhatItDidProps) {
  const current = useOutcome(stage, type, artifactId)
  const [extra, setExtra] = useState<Extra | null>(null)

  // The previous run's headline, for "(was N)", and the plugin's note.
  useEffect(() => {
    let live = true
    const previous = previousId && previousId !== artifactId ? loadPayload(previousId).catch(() => null) : Promise.resolve(null)
    const note = loadMeta(artifactId).then(
      (m) => (typeof m?.meta?.note === "string" && m.meta.note.trim() ? m.meta.note.trim() : null),
      () => null,
    )
    Promise.all([previous, note]).then(([before, n]) => {
      if (live) setExtra({ id: artifactId, before: before === null ? null : outcomeFor(stage, type, before), note: n })
    })
    return () => {
      live = false
    }
  }, [stage, type, artifactId, previousId])

  if (!current || current.kind === "loading" || extra?.id !== artifactId) return null
  if (current.kind === "error") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold">What it did</span>
        <span className="text-xs text-fg-muted">Could not read the output.</span>
      </div>
    )
  }
  const sentence = current.outcome ? outcomeText(current.outcome, extra.before?.headline) : null
  if (!sentence && !extra.note) return null
  const text = preferNote && extra.note && !stale ? null : sentence
  return (
    <div className="flex flex-col gap-1" data-testid="what-it-did" data-stale={stale ? "" : undefined}>
      <span className="text-xs font-semibold">What it did</span>
      {text ? (
        <p className={cn("m-0 text-base break-words", stale ? "text-fg-muted" : "text-fg")}>
          <MonoNumbers text={text} />
        </p>
      ) : null}
      {extra.note && !stale ? <p className="m-0 text-base text-fg">{extra.note}</p> : null}
    </div>
  )
}
