import { useState } from "react"

import type { Chunk, ChunkSet, ChunkStats } from "@/api/types"
import { EvidenceSlip, LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { rowFromChunk, type FindingPart } from "@/components/inspectors/hits"
import { fmt } from "@/components/inspectors/status"
import { ChunkBar } from "@/components/pipeline/NodeCard"
import type { FileInfo } from "@/lib/files"
import { cn } from "@/lib/utils"

import { FileScale } from "./FileScale"

/**
 * A Compare chunk column as evidence: the numbers that sum up the cut, the
 * document as a bar drawn to scale by tokens, then the first pieces as flat
 * slips, each named by its number, its tokens and its heading. The rest wait
 * behind Show all. The column is as tall as its content; the page scrolls.
 * Build's chunk inspector, with its colour wash over the text, stays on Build.
 * With several documents the numbers are Pandion's totals over all of them,
 * each file gets its own line in the scale picture, and each piece names its file.
 */

/** Pieces shown before Show all. */
const FIRST = 4

const piecesWord = (n: number) => `${n} ${n === 1 ? "piece" : "pieces"}`

/** `Piece 1, 58 tokens, under the heading Reading order in two-column reports`; `Piece 1 of <file>` with several documents. */
function pieceFinding(c: Chunk, index: number, file?: FileInfo): FindingPart[] {
  const heading = c.heading_path.length ? c.heading_path[c.heading_path.length - 1] : null
  return [
    { text: `Piece ${index + 1}`, place: true },
    ...(file ? [{ text: ` of ${file.filename}` }] : []),
    { text: ", " },
    { text: fmt(c.token_count), mono: true },
    { text: c.token_count === 1 ? " token" : " tokens" },
    ...(heading ? [{ text: `, under the heading ${heading}` }] : []),
  ]
}

export function ChunkEvidence({
  set,
  files,
  stats: given,
  statsFailed = false,
}: {
  set: ChunkSet
  /** With several documents: each file's own chunk set, in the pipeline's order. */
  files?: { file: FileInfo; set: ChunkSet }[]
  /** With several documents: Pandion's totals over all of them, undefined until they arrive (never one file's numbers). */
  stats?: ChunkStats
  /** With several documents: the totals could not be read. */
  statsFailed?: boolean
}) {
  const stats = files ? given : (given ?? set.stats)
  const [all, setAll] = useState(false)
  // Every piece, with its number in its own document and, with several, its file.
  const pieces = files ? files.flatMap(({ file, set: s }) => s.chunks.map((c, k) => ({ c, k, file }))) : set.chunks.map((c, k) => ({ c, k, file: undefined }))
  const n = pieces.length
  const shown = all ? pieces : pieces.slice(0, FIRST)
  const rest = n - shown.length
  const value = (v: number | null) => (v === null ? "none" : fmt(v))
  const numbers: [string, string][] = [
    ["pieces", value(stats?.pieces ?? null)],
    ["tokens", value(stats?.tokens ?? null)],
    ["median tokens", value(stats?.median_tokens ?? null)],
    ["largest 5%", value(stats?.p95_tokens ?? null)],
    ["characters left out", value(stats?.uncovered ?? null)],
  ]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {files && !stats ? (
        statsFailed ? (
          <p role="alert" className="m-0 text-sm text-danger">
            The numbers over every document could not be read. Run again to try once more.
          </p>
        ) : (
          <p role="status" className="m-0 text-sm text-fg-muted">
            Adding up the numbers over every document.
          </p>
        )
      ) : (
        <dl data-testid="chunk-numbers" className="m-0 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-3 gap-y-2">
          {numbers.map(([label, v]) => (
            <div key={label} className="flex flex-col">
              <dt className="order-2 text-xs text-fg-muted">{label}</dt>
              <dd className="m-0 font-mono text-lg font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {n ? (
        <div className="flex flex-col gap-1">
          {files ? <FileScale lines={files} /> : <ChunkBar data={set} size="bar" />}
          <p className="text-xs text-fg-muted">
            {files ? `The ${files.length} documents as ${piecesWord(n)}, each on its own line, drawn to scale by tokens.` : `The document as ${piecesWord(n)}, drawn to scale by tokens.`}
          </p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">This recipe cut the document into no pieces.</p>
      )}
      {n ? (
        <div role="list" aria-label="Pieces" className="flex min-w-0 flex-col gap-1">
          {shown.map(({ c, k, file }) => (
            <EvidenceSlip
              key={`${file?.sha ?? ""}:${c.id}`}
              role="listitem"
              row={{ ...rowFromChunk(c), section: null }}
              side="single"
              piece={k}
              scaleKey="score"
              compact
              scores={false}
              finding={pieceFinding(c, k, file)}
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
