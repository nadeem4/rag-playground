import { useMemo } from "react"

import type { ChunkSet } from "@/api/types"
import { analyzeChunks, seeingLines } from "@/learn/chunks"
import { LESSONS_ENABLED } from "@/state/lessons"

const isChunkSet = (x: unknown): x is ChunkSet =>
  typeof x === "object" && x !== null && Array.isArray((x as ChunkSet).chunks) && typeof (x as ChunkSet).source_text === "string"

/**
 * Above the Chunk card's output on Build: what the user's real chunk set
 * shows, and a way to practise. Nothing without a chunk set. The link to the
 * chunking lesson is left out while the lessons are hidden.
 */
export function WhatYouAreSeeing({ data, lessonsEnabled = LESSONS_ENABLED }: { data: unknown; lessonsEnabled?: boolean }) {
  const lines = useMemo(() => (isChunkSet(data) ? seeingLines(analyzeChunks(data)) : null), [data])
  if (!lines) return null
  return (
    <section aria-label="What you are seeing" data-learn="" className="mb-3 flex max-w-[82ch] flex-col gap-1 rounded-panel bg-surface-elevated p-3 text-sm">
      <h3 className="m-0 text-sm font-semibold">What you are seeing</h3>
      {lines.map((l) => (
        <p key={l} className="m-0">
          {l}
        </p>
      ))}
      {lessonsEnabled ? (
        <a href="/learn/chunking" className="w-fit text-fg underline decoration-fg-muted underline-offset-2">
          Practice in the chunking lesson
        </a>
      ) : null}
    </section>
  )
}
