import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"

import type { ParsedDoc } from "@/api/types"
import { Button } from "@/components/ui/button"

import "./pdf.css"

/**
 * The place a page view stands, for a document without pages (Word, a web
 * page, Markdown, text, and images and slides, whose boxes are not in PDF
 * points): the document's text in a scrolling panel, with the cited or
 * selected piece marked in its chunk's hue, the same mark a page highlight
 * uses. The panel scrolls to the first mark.
 */
export function TextView({
  title,
  text,
  marks,
  slot = null,
  notice,
  onClose,
}: {
  title: ReactNode
  text: string
  /** Character ranges of `text` to mark, `[start, end)`. */
  marks: readonly [number, number][]
  slot?: number | null
  notice?: ReactNode
  onClose?: () => void
}) {
  const first = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const ranges = [...marks].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const firstStart = ranges[0]?.[0] ?? null
  // Only the text panel scrolls to the first mark, never the page or the panel around it.
  useEffect(() => {
    if (panel.current && first.current) panel.current.scrollTop = Math.max(0, first.current.offsetTop - 48)
  }, [text, firstStart])

  const tone = { "--hl": slot === null ? "var(--text-secondary)" : `var(--chunk-${slot})` } as CSSProperties
  const parts: ReactNode[] = []
  let at = 0
  ranges.forEach(([a, b], k) => {
    const start = Math.max(a, at)
    if (b <= start) return
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={k} ref={k === 0 ? first : undefined} className="pdf-hl text-fg" style={tone}>
        {text.slice(start, b)}
      </mark>,
    )
    at = b
  })
  parts.push(text.slice(at))

  return (
    <section aria-label="Document text" data-text-view="" className="flex flex-col bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-3 py-1">
        <span className="text-sm font-semibold">{title}</span>
        {onClose ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
      {notice ? <p className="border-b border-hairline px-3 py-2 text-xs text-fg-muted">{notice}</p> : null}
      <div ref={panel} className="relative max-h-[480px] overflow-auto bg-surface-elevated p-3">
        <p className="m-0 max-w-[82ch] font-serif text-base leading-[1.55] whitespace-pre-wrap text-fg">{parts}</p>
      </div>
    </section>
  )
}

/** A parsed document's text, its elements joined by blank lines, and where each listed element sits in it. */
export function elementsText(doc: ParsedDoc, ids: readonly string[]): { text: string; marks: [number, number][] } {
  const want = new Set(ids)
  const marks: [number, number][] = []
  let text = ""
  for (const e of [...doc.elements].sort((a, b) => a.order - b.order)) {
    if (!e.text) continue
    if (text) text += "\n\n"
    if (want.has(e.id)) marks.push([text.length, text.length + e.text.length])
    text += e.text
  }
  return { text, marks }
}
