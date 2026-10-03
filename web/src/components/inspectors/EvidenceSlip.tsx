import type { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"
import { CHUNK_CLASSES } from "@/styles/dataClasses"

import { componentKeys, findingLine, fmtScore, pages, scaleName, type HitRowData, type SlipSide } from "./hits"
import { chunkSlot } from "./spans"

/**
 * One piece of evidence (spec section 5): the piece's swatch on the left, and
 * on the right the finding line in the tool's voice, the passage in the
 * document voice, and a meta line with the page, the section, the scores with
 * their scales named, and Show in PDF. A Not kept slip is faint, says why it
 * fell out, and carries no scores.
 */

export interface EvidenceSlipProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  row: HitRowData
  side: SlipSide
  /** The piece's index in its chunk set: its number and its colour. Null when the set does not hold it. */
  piece: number | null
  /** The scale of the row's `score` (`scoreKey(rows)`). */
  scaleKey: string
  /** Clamp the passage to two lines (the search side of the comparison). */
  clamp?: boolean
  /** The keep limit a Not kept slip names. */
  keepLimit?: number
  /** The component scores to show, in order; the row's own when not given. */
  keys?: string[]
  /** The heading path as one line. */
  section?: string | null
  /** The retriever, when the list mixes them. */
  retriever?: string | null
  onShowInPdf?: () => void
  [data: `data-${string}`]: string | number | undefined
}

/** What an absent component score means, by the search that missed the hit. */
const MISSED: Record<string, string> = { bm25: "no keyword match", dense: "no meaning match" }

export const LINK_BUTTON =
  "cursor-pointer rounded-control font-medium text-primary underline-offset-4 transition-colors duration-(--dur-fast) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"

export function EvidenceSlip({
  row,
  side,
  piece,
  scaleKey,
  clamp = false,
  keepLimit,
  keys,
  section,
  retriever,
  onShowInPdf,
  className,
  ...rest
}: EvidenceSlipProps) {
  const notKept = side === "notKept"
  const parts = findingLine(row, side, scaleKey, keepLimit)
  const scores: { name: string; value: number | undefined; missed?: string }[] = notKept
    ? []
    : [
        ...(side === "search" ? [] : [{ name: scaleName(scaleKey), value: row.score }]),
        ...(keys ?? componentKeys([row])).map((k) => ({ name: scaleName(k), value: row.component_scores[k], missed: MISSED[k] ?? "no match" })),
      ]
  const page = pages(row.page_span)
  return (
    <div
      data-slip=""
      {...rest}
      className={cn(
        "ev-slip grid min-h-[44px] grid-cols-[30px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-panel p-[10px_12px] transition-colors duration-(--dur-fast)",
        "hover:bg-surface-raised hover:ring-1 hover:ring-hairline focus-within:bg-surface-raised focus-within:ring-1 focus-within:ring-hairline",
        notKept && "opacity-75",
        className,
      )}
    >
      <span
        data-id={row.chunk_id}
        aria-label={piece === null ? "Chunk not in this chunk set" : `Chunk ${piece + 1}`}
        className={cn(
          "grid size-[30px] place-items-center rounded-swatch font-mono text-xs font-semibold tabular-nums",
          piece === null ? "bg-surface-elevated text-fg-muted" : notKept ? "border border-flat text-fg-muted" : CHUNK_CLASSES[chunkSlot(piece) - 1],
        )}
      >
        {piece === null ? "" : piece + 1}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p data-testid="finding" className="font-sans text-sm text-fg-muted">
          {parts.map((p, i) => (
            <span key={i} className={cn(p.strong && "font-semibold text-fg", p.mono && "font-mono text-fg tabular-nums")}>
              {p.text}
            </span>
          ))}
        </p>
        <p data-testid="passage" className={cn("font-serif text-base leading-[1.55] break-words whitespace-pre-line text-fg", clamp && "line-clamp-2")}>
          {row.text}
        </p>
        <p data-testid="meta" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-fg-muted">
          {page ? <span className="tabular-nums">{page}</span> : null}
          {(section ?? row.section) ? <span>{section ?? row.section}</span> : null}
          {retriever ? <span className="font-mono">{retriever}</span> : null}
          {scores.map((s) => (
            <span key={s.name} data-score={s.name} className="whitespace-nowrap">
              {s.name}{" "}
              {s.value === undefined ? (
                <span className="font-sans whitespace-nowrap">{s.missed ?? ""}</span>
              ) : (
                <span className="font-mono text-fg tabular-nums">{fmtScore(s.value)}</span>
              )}
            </span>
          ))}
          {onShowInPdf ? (
            <button
              type="button"
              className={LINK_BUTTON}
              onClick={(e) => {
                e.stopPropagation()
                onShowInPdf()
              }}
            >
              Show in PDF
            </button>
          ) : null}
        </p>
      </div>
    </div>
  )
}
