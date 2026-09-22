import { useState, type CSSProperties, type ReactNode } from "react"

import { api } from "@/api/client"
import type { PdfRect } from "@/api/types"
import { usePageSizes } from "@/api/usePdf"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { pdfRectToCss } from "./geometry"
import "./pdf.css"

/**
 * One page of the original PDF, rendered by the server, with regions drawn
 * over it (plan I-9). Highlights are Channel B: the fill is the hue of the
 * chunk the region belongs to, the same hue that chunk has in every other
 * view. A region the text search did not confirm (a whole element standing in
 * for a quote) is dashed and lighter, never the same mark as a found quote.
 *
 * The page is drawn at a fixed `scale` CSS px per point, so the overlay is
 * pure arithmetic on the page size: nothing is measured, no state follows the
 * pointer, and a narrow panel scrolls the page instead of reflowing it.
 */

export interface Highlight {
  page: number
  rect: PdfRect
  /** Stands in for the real region (an element's bbox, not the found text). */
  approximate?: boolean
}

export interface PdfPageViewProps {
  sha: string
  initialPage: number
  highlights: Highlight[]
  /** Chunk palette slot of the highlighted chunk; null draws a neutral mark. */
  slot?: number | null
  /** What is shown, in words: "Chunk 3", "Rank 2", "Citation 1". */
  title: ReactNode
  /** One plain sentence about the highlight: what it is, or why it is missing. */
  notice?: ReactNode
  onClose?: () => void
  /** CSS px per PDF point. */
  scale?: number
}

const IMAGE_SCALE = 2

export function PdfPageView({ sha, initialPage, highlights, slot = null, title, notice, onClose, scale = 1.25 }: PdfPageViewProps) {
  const sizes = usePageSizes(sha)
  const [page, setPage] = useState(initialPage)
  const [img, setImg] = useState<{ src: string; state: "ok" | "error" }>({ src: "", state: "ok" })

  const tone = {
    "--hl": slot === null ? "var(--text-secondary)" : `var(--chunk-${slot})`,
  } as CSSProperties

  let body: ReactNode
  let count = 0
  if (sizes.kind === "loading") {
    body = (
      <p role="status" className="p-3 text-sm text-fg-muted">
        Loading the pages of this PDF
      </p>
    )
  } else if (sizes.kind === "error") {
    body = (
      <div role="alert" className="flex flex-col gap-1 p-3">
        <p className="text-sm font-medium text-danger">Could not load the pages of this PDF</p>
        <p className="max-w-[82ch] font-mono text-xs break-words text-fg-muted">{sizes.message}</p>
      </div>
    )
  } else if (sizes.data.length === 0) {
    body = <p className="p-3 text-sm text-fg-muted">This PDF has no pages.</p>
  } else {
    count = sizes.data.length
    const n = Math.min(Math.max(1, page), count)
    const size = sizes.data.find((p) => p.n === n) ?? sizes.data[n - 1]
    const src = api.pageImageUrl(sha, n, IMAGE_SCALE)
    const failed = img.src === src && img.state === "error"
    const loaded = img.src === src && img.state === "ok"
    const here = highlights.filter((h) => h.page === n)
    body = (
      <div className="overflow-auto bg-surface-elevated p-3">
        <div
          data-pdf-page={n}
          className="pdf-page relative bg-surface"
          style={{ width: size.width * scale, height: size.height * scale }}
        >
          {failed ? (
            <div role="alert" className="flex flex-col gap-1 p-3">
              <p className="text-sm font-medium text-danger">Could not render page {n}</p>
              <p className="text-xs text-fg-muted">The server did not return an image for this page.</p>
            </div>
          ) : (
            <img
              key={src}
              src={src}
              alt={`Page ${n} of ${count}`}
              draggable={false}
              className="pdf-img absolute inset-0 size-full select-none"
              onLoad={() => setImg({ src, state: "ok" })}
              onError={() => setImg({ src, state: "error" })}
            />
          )}
          {!failed && !loaded ? (
            <span role="status" className="sr-only">
              Rendering page {n}
            </span>
          ) : null}
          {here.map((h, k) => {
            const box = pdfRectToCss(h.rect, size, scale)
            return (
              <span
                key={k}
                data-highlight=""
                data-approximate={h.approximate ? "" : undefined}
                aria-hidden
                className="pdf-hl absolute"
                style={{ ...tone, left: box.left, top: box.top, width: box.width, height: box.height }}
              />
            )
          })}
        </div>
      </div>
    )
  }

  const n = count ? Math.min(Math.max(1, page), count) : page
  const elsewhere = [...new Set(highlights.map((h) => h.page))].filter((p) => p !== n).sort((a, b) => a - b)
  const onPage = highlights.filter((h) => h.page === n).length

  return (
    <section aria-label="PDF page" data-pdf-view="" className="flex min-w-0 flex-col bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-semibold">{title}</span>
          <span className="font-mono text-xs text-fg tabular-nums" data-testid="pdf-page-number">
            p. {n}
            {count ? ` of ${count}` : ""}
          </span>
          {/* Nothing is being pointed at (a lesson showing the plain pages): no count to give. */}
          {highlights.length ? (
            <span className="text-xs text-fg-muted" data-testid="pdf-region-count">
              {onPage === 1 ? "1 region on this page" : `${onPage} regions on this page`}
            </span>
          ) : null}
          {elsewhere.length ? (
            <span className="flex items-baseline gap-1 text-xs text-fg-muted">
              also on
              {elsewhere.map((p) => (
                <button key={p} type="button" className="font-mono text-fg underline underline-offset-2" onClick={() => setPage(p)}>
                  p. {p}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={!count || n <= 1} onClick={() => setPage(n - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!count || n >= count} onClick={() => setPage(n + 1)}>
            Next
          </Button>
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </div>
      {notice ? (
        <p data-testid="pdf-notice" className={cn("border-b border-hairline px-3 py-2 text-xs text-fg-muted")}>
          {notice}
        </p>
      ) : null}
      {body}
    </section>
  )
}
