import { useState, type HTMLAttributes } from "react"

import { cn } from "@/lib/utils"
import { CHUNK_CLASSES } from "@/styles/dataClasses"

import { componentKeys, findingLine, fmtScore, pages, scaleName, type HitRowData, type SlipSide } from "./hits"
import { chunkSlot } from "./spans"

/**
 * One piece of evidence (spec section 5): the piece's swatch on the left, and
 * on the right the finding line in the tool's voice, the passage in the
 * document voice, and a meta line with the page, the section, the scores with
 * their scales named, and Show in PDF. A Not kept slip is faint, says why it
 * fell out, and carries no scores. A bare slip is the swatch and the passage,
 * with the page and section only when they are known: for a text that has no
 * rank and no score (Evaluate's closest text).
 */

export interface EvidenceSlipProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  row: HitRowData
  side: SlipSide
  /** The piece's index in its chunk set: its number and its colour. Null when the set does not hold it. */
  piece: number | null
  /** The scale of the row's `score` (`scoreKey(rows)`). */
  scaleKey: string
  /** Clamp the passage to two lines. */
  clamp?: boolean
  /**
   * A slip in the comparison: the passage is clamped to two lines on either
   * side, and Show more on the meta line opens it in place. Overrides `clamp`.
   */
  compact?: boolean
  /** Lit by the linked highlight: the raised look of a hovered slip, wherever the pointer is. */
  lit?: boolean
  /** The keep limit a Not kept slip names. */
  keepLimit?: number
  /** The reranker's transform key, for why a Not kept slip was left out. */
  reranker?: string
  /** The component scores to show, in order; the row's own when not given. */
  keys?: string[]
  /** The heading path as one line. */
  section?: string | null
  /** The retriever, when the list mixes them. */
  retriever?: string | null
  onShowInPdf?: () => void
  /** No finding line and no scores: the row has no rank or score worth saying. Not a tab stop. */
  bare?: boolean
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
  compact = false,
  lit = false,
  keepLimit,
  reranker,
  keys,
  section,
  retriever,
  onShowInPdf,
  bare = false,
  className,
  ...rest
}: EvidenceSlipProps) {
  const notKept = side === "notKept"
  // Compact, both sides of the comparison share one anatomy: the place line has no score, and the meta line has the side's one score.
  const parts = bare ? [] : findingLine(row, side, scaleKey, keepLimit, reranker, !compact)
  const scores: { name: string; value: number | undefined; missed?: string }[] =
    notKept || bare
      ? []
      : compact
        ? [{ name: scaleName(scaleKey), value: row.score }]
        : [
            ...(side === "search" ? [] : [{ name: scaleName(scaleKey), value: row.score }]),
            ...(keys ?? componentKeys([row])).map((k) => ({ name: scaleName(k), value: row.component_scores[k], missed: MISSED[k] ?? "no match" })),
          ]
  const page = pages(row.page_span)
  const where = section ?? row.section
  const [more, setMore] = useState(false)
  const clamped = compact ? !more : clamp
  const meta = Boolean(page || where || retriever || scores.length || onShowInPdf || compact)
  const place = (
    <>
      {page ? <span className="tabular-nums">{page}</span> : null}
      {where ? <span>{where}</span> : null}
      {retriever ? <span className="font-mono">{retriever}</span> : null}
    </>
  )
  const showMore = compact ? (
    <button
      type="button"
      aria-expanded={more}
      className={LINK_BUTTON}
      onClick={(e) => {
        e.stopPropagation()
        setMore(!more)
      }}
    >
      {more ? "Show less" : "Show more"}
    </button>
  ) : null
  const showInPdf = onShowInPdf ? (
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
  ) : null
  const tail = (
    <>
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
      {/* Compact, the two buttons stay together: on a narrow slip the score wraps, not a button. */}
      {compact ? (
        <span data-actions="" className="flex gap-x-3 whitespace-nowrap">
          {showMore}
          {showInPdf}
        </span>
      ) : (
        showInPdf
      )}
    </>
  )
  return (
    <div
      data-slip=""
      data-lit={lit ? "" : undefined}
      tabIndex={bare ? undefined : 0}
      {...rest}
      className={cn(
        "ev-slip grid min-h-[44px] grid-cols-[30px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-panel p-[10px_12px] transition-colors duration-(--dur-fast)",
        "hover:bg-surface-raised hover:ring-1 hover:ring-hairline focus-within:bg-surface-raised focus-within:ring-1 focus-within:ring-hairline",
        "focus-visible:bg-surface-raised focus-visible:ring-1 focus-visible:ring-hairline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)",
        notKept && "opacity-75",
        lit && "bg-surface-raised ring-1 ring-hairline",
        className,
      )}
    >
      <span
        data-id={row.chunk_id}
        // A bare slip's text is not a chunk, so its swatch claims nothing; a hit's swatch names its piece.
        role={bare ? undefined : "img"}
        aria-label={bare ? undefined : piece === null ? "Chunk not in this chunk set" : `Chunk ${piece + 1}`}
        aria-hidden={bare ? true : undefined}
        title={bare ? undefined : `Piece ${row.chunk_id.slice(0, 8)}`}
        className={cn(
          "grid size-[30px] place-items-center rounded-swatch font-mono text-xs font-semibold tabular-nums",
          piece === null ? "bg-surface-elevated text-fg-muted" : notKept ? "border border-flat text-fg-muted" : CHUNK_CLASSES[chunkSlot(piece) - 1],
        )}
      >
        {piece === null ? "" : piece + 1}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {parts.length ? (
          <p data-testid="finding" className="font-sans text-sm text-fg-muted">
            {parts.map((p, i) => (
              <span key={i} className={cn((p.place || p.strong) && "font-semibold text-fg", p.mono && "font-mono text-fg tabular-nums")}>
                {p.text}
              </span>
            ))}
          </p>
        ) : null}
        {/* Clamped, the passage flows as plain text: a kept blank line would use up a clamped line. */}
        <p data-testid="passage" className={cn("font-serif text-base leading-[1.55] break-words text-fg", clamped ? "line-clamp-2" : "whitespace-pre-line")}>
          {row.text}
        </p>
        {meta ? (
          <p data-testid="meta" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-fg-muted">
            {compact ? (
              <>
                {/* Below md, where the piece is takes one line and its score and the two buttons the next. */}
                {page || where || retriever ? <span className="flex min-w-0 basis-full flex-wrap items-baseline gap-x-3 md:basis-auto">{place}</span> : null}
                <span className="flex flex-wrap items-baseline gap-x-3">{tail}</span>
              </>
            ) : (
              <>
                {place}
                {tail}
              </>
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
