import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { ChunkAnalysis, ChunkView } from "@/learn/chunks"
import { cn } from "@/lib/utils"

/**
 * The real chunks as cards. Repeated text is hatched (contract §3: overlap is
 * a hatch, not a third hue), the answer sentence is underlined, and a cut
 * through it is named in words. Each card's left rule is its chunk hue.
 */

/** A long chunk set shows the chunks around the answer first. */
const WINDOW = 8

const HATCH = {
  background: "repeating-linear-gradient(135deg, color-mix(in oklch, var(--text-secondary) 24%, transparent) 0 2px, transparent 2px 6px)",
}

function Body({ view }: { view: ChunkView }) {
  const text = view.chunk.text
  const [a0, a1] = view.answer ?? [0, 0]
  // Split one range of the text at the answer's edges, underlining its part.
  const piece = (from: number, to: number, key: string): ReactNode[] => {
    const cuts = [from, ...[a0, a1].filter((x) => x > from && x < to), to]
    return cuts.slice(0, -1).map((s, i) => {
      const e = cuts[i + 1]
      const inAnswer = view.answer !== null && s >= a0 && s < a1
      return inAnswer ? (
        <span key={`${key}${s}`} data-answer="" className="underline decoration-fg decoration-2 underline-offset-[3px]">
          {text.slice(s, e)}
        </span>
      ) : (
        <span key={`${key}${s}`}>{text.slice(s, e)}</span>
      )
    })
  }
  const rep = Math.min(view.repeat, text.length)
  return (
    <>
      {rep > 0 ? (
        <span data-repeated="" title="Repeated from the chunk before" style={HATCH}>
          {piece(0, rep, "r")}
        </span>
      ) : null}
      {piece(rep, text.length, "t")}
    </>
  )
}

function Card({ view, index, unit }: { view: ChunkView; index: number; unit: "characters" | "tokens" }) {
  const c = view.chunk
  const size = unit === "tokens" ? `${c.token_count} tokens` : `${c.end_char - c.start_char} characters`
  return (
    <li
      className={cn("min-w-0 rounded-panel border bg-surface", view.answer ? "border-fg-muted" : "border-hairline")}
      style={{ borderLeft: `3px solid var(--chunk-${(index % 8) + 1})` }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-hairline px-3 py-1 text-xs text-fg-muted">
        <span className="font-medium text-fg">Chunk {index + 1}</span>
        <span className="font-mono">
          {size}
          {view.repeat > 0 ? `, starts with text from chunk ${index}` : ""}
        </span>
      </div>
      <p className="m-0 px-3 py-2 font-mono text-sm leading-[1.75] break-words whitespace-pre-wrap">
        <Body view={view} />
      </p>
      {view.continuesIn !== null ? (
        <p className="m-0 px-3 pb-2 text-xs font-medium text-danger">
          The answer sentence is cut here and continues in chunk {view.continuesIn + 1}.
        </p>
      ) : null}
    </li>
  )
}

export function ChunkCards({ analysis, unit }: { analysis: ChunkAnalysis; unit: "characters" | "tokens" }) {
  const [all, setAll] = useState(false)
  const total = analysis.chunks.length
  let from = 0
  let to = total
  if (!all && total > WINDOW) {
    const around = analysis.touching.length ? analysis.touching : [0]
    from = Math.max(0, Math.min(...around) - 1)
    to = Math.min(total, Math.max(...around) + 2)
  }
  const partial = from > 0 || to < total
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {partial ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-sm text-fg-muted">
            Showing chunks {from + 1} to {to} of {total}, around the answer sentence.
          </p>
          <Button variant="outline" size="sm" onClick={() => setAll(true)}>
            Show all {total} chunks
          </Button>
        </div>
      ) : null}
      <ol aria-label="Chunks" className="m-0 flex list-none flex-col gap-2 p-0">
        {analysis.chunks.slice(from, to).map((v, k) => (
          <Card key={v.chunk.id} view={v} index={from + k} unit={unit} />
        ))}
      </ol>
    </div>
  )
}
