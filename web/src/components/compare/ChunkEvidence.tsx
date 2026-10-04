import { useMemo, useState } from "react"

import type { Chunk, ChunkSet } from "@/api/types"
import { EvidenceSlip, LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { rowFromChunk, type FindingPart } from "@/components/inspectors/hits"
import { chunkStats } from "@/components/inspectors/spans"
import { fmt } from "@/components/inspectors/status"
import { ChunkBar } from "@/components/pipeline/NodeCard"
import { cn } from "@/lib/utils"

/**
 * A Compare chunk column as evidence: the numbers that sum up the cut, the
 * document as a bar drawn to scale by tokens, then the first pieces as flat
 * slips, each named by its number, its tokens and its heading. The rest wait
 * behind Show all. The column is as tall as its content; the page scrolls.
 * Build's chunk inspector, with its colour wash over the text, stays on Build.
 */

/** Pieces shown before Show all. */
const FIRST = 4

const piecesWord = (n: number) => `${n} ${n === 1 ? "piece" : "pieces"}`

/** `Piece 1, 58 tokens, under the heading Reading order in two-column reports`. */
function pieceFinding(c: Chunk, index: number): FindingPart[] {
  const heading = c.heading_path.length ? c.heading_path[c.heading_path.length - 1] : null
  return [
    { text: `Piece ${index + 1}`, place: true },
    { text: ", " },
    { text: fmt(c.token_count), mono: true },
    { text: c.token_count === 1 ? " token" : " tokens" },
    ...(heading ? [{ text: `, under the heading ${heading}` }] : []),
  ]
}

export function ChunkEvidence({ set }: { set: ChunkSet }) {
  const stats = useMemo(() => chunkStats(set), [set])
  const [all, setAll] = useState(false)
  const n = set.chunks.length
  const shown = all ? set.chunks : set.chunks.slice(0, FIRST)
  const rest = n - shown.length
  const value = (v: number | null) => (v === null ? "none" : fmt(v))
  const numbers: [string, string][] = [
    ["pieces", value(stats.pieces)],
    ["tokens", value(stats.tokens)],
    ["median tokens", value(stats.median)],
    ["largest 5%", value(stats.p95)],
    ["characters left out", value(stats.uncovered)],
  ]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl data-testid="chunk-numbers" className="m-0 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-3 gap-y-2">
        {numbers.map(([label, v]) => (
          <div key={label} className="flex flex-col">
            <dt className="order-2 text-xs text-fg-muted">{label}</dt>
            <dd className="m-0 font-mono text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {n ? (
        <div className="flex flex-col gap-1">
          <ChunkBar data={set} size="bar" />
          <p className="text-xs text-fg-muted">The document as {piecesWord(n)}, drawn to scale by tokens.</p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">This recipe cut the document into no pieces.</p>
      )}
      {n ? (
        <div role="list" aria-label="Pieces" className="flex min-w-0 flex-col gap-1">
          {shown.map((c, i) => (
            <EvidenceSlip
              key={c.id}
              role="listitem"
              row={{ ...rowFromChunk(c), section: null }}
              side="single"
              piece={i}
              scaleKey="score"
              compact
              scores={false}
              finding={pieceFinding(c, i)}
            />
          ))}
        </div>
      ) : null}
      {rest > 0 ? (
        <p className="pl-[54px] text-sm text-fg-muted">
          {`${rest} more ${rest === 1 ? "piece" : "pieces"}.`}{" "}
          <button
            type="button"
            onClick={() => setAll(true)}
            className={cn(LINK_BUTTON, "underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center")}
          >
            Show all
          </button>
        </p>
      ) : null}
    </div>
  )
}
