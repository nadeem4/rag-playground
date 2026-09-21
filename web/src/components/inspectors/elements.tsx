import type { ReactNode } from "react"

import type { Element } from "@/api/types"
import { cn } from "@/lib/utils"

/**
 * One parsed element as one block. There is deliberately NO markdown
 * projection here: `render_markdown` lives in Python only, and positions in
 * element views come from measuring these blocks, not from offsets.
 */

/** Pagination artefacts: kept in the view, drawn quietly. */
const QUIET = new Set(["header", "footer", "page_number"])

export function ElementText({ el }: { el: Element }) {
  switch (el.type) {
    case "heading":
      return (
        <p className="text-base leading-[1.65] font-semibold">
          <span aria-hidden className="mr-2 font-mono text-fg-muted">
            {"#".repeat(Math.max(1, el.level ?? 1))}
          </span>
          {el.text}
        </p>
      )
    case "list_item":
      return (
        <p className="text-base leading-[1.65]" style={{ paddingLeft: Math.max(0, (el.level ?? 1) - 1) * 16 }}>
          <span aria-hidden className="mr-2 font-mono text-fg-muted">
            -
          </span>
          {el.text}
        </p>
      )
    case "code":
    case "table":
    case "formula":
      return (
        <pre className="overflow-x-auto rounded-control border border-hairline bg-surface-elevated p-2 font-mono text-xs">{el.text}</pre>
      )
    default:
      return (
        <p className={cn("text-base leading-[1.65] whitespace-pre-wrap", QUIET.has(el.type) && "text-fg-muted")}>
          {el.text}
        </p>
      )
  }
}

/** The gutter: order is the element's identity in reading order, so it leads. */
export function OrderGutter({ el, extra }: { el: Element; extra?: ReactNode }) {
  return (
    <div className="flex flex-col items-end pt-[3px] text-right">
      <span className="font-mono text-xs font-medium text-fg tabular-nums">{el.order}</span>
      {el.type !== "paragraph" ? <span className="meta normal-case">{el.type}</span> : null}
      {extra}
    </div>
  )
}

export function PageBreak({ page }: { page: number | null }) {
  return (
    <div className="flex items-center gap-2 py-1" role="separator" aria-label={`Page ${page ?? "unknown"}`}>
      <span className="meta">page {page ?? "?"}</span>
      <span aria-hidden className="h-px flex-1 bg-hairline" />
    </div>
  )
}

export function byOrder(elements: readonly Element[]): Element[] {
  return [...elements].sort((a, b) => a.order - b.order)
}
