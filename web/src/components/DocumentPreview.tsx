import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { api } from "@/api/client"
import { usePageSizes } from "@/api/usePdf"
import { cn } from "@/lib/utils"
import type { DocRef } from "@/state/document"

import { FactsLine, type DocumentFacts } from "./DocumentItem"
import { SideSheet } from "./SideSheet"

const reduceMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * A document's Preview: the side sheet with the title and facts line in its
 * header, a row of page numbers to jump to a page (the one in view is marked
 * while scrolling), then every page, captioned "Page 3 of 6". It sits on the
 * body, so no card or sticky bar can clip it.
 */
export function DocumentPreview({ doc, facts, onClose }: { doc: DocRef; facts: DocumentFacts; onClose: () => void }) {
  const sizes = usePageSizes(doc.sha)
  const pages = sizes.kind === "ready" ? sizes.data : []
  const [current, setCurrent] = useState(1)
  const figures = useRef(new Map<number, HTMLElement>())

  // The page in view is the top-most one crossing the upper part of the screen.
  useEffect(() => {
    if (!pages.length || typeof IntersectionObserver === "undefined") return
    const seen = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page)
          if (e.isIntersecting) seen.add(n)
          else seen.delete(n)
        }
        if (seen.size) setCurrent(Math.min(...seen))
      },
      { rootMargin: "0px 0px -60% 0px" },
    )
    figures.current.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [pages.length])

  const jump = (n: number) => {
    setCurrent(n)
    figures.current.get(n)?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" })
  }

  const head = (
    <>
      <FactsLine facts={{ ...facts, pages: pages.length || facts.pages }} />
      {pages.length > 1 ? (
        <nav aria-label="Go to page" className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <button
              key={p.n}
              type="button"
              aria-label={`Page ${p.n}`}
              aria-current={current === p.n ? "true" : undefined}
              onClick={() => jump(p.n)}
              className={cn(
                "min-h-row-compact min-w-8 rounded-swatch border px-1 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
                current === p.n ? "border-primary bg-accent-wash text-fg" : "border-hairline bg-surface text-fg-muted hover:bg-surface-hover",
              )}
            >
              {p.n}
            </button>
          ))}
        </nav>
      ) : null}
    </>
  )

  return createPortal(
    <SideSheet title={facts.title} onClose={onClose} head={head}>
      {sizes.kind === "loading" ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading the pages
        </p>
      ) : sizes.kind === "error" ? (
        <p role="alert" className="text-sm text-danger">
          Could not load the pages of this PDF.
        </p>
      ) : (
        pages.map((p) => (
          <figure
            key={p.n}
            data-page={p.n}
            ref={(el) => {
              if (el) figures.current.set(p.n, el)
              else figures.current.delete(p.n)
            }}
            className="m-0 flex scroll-mt-4 flex-col items-center gap-1"
          >
            <img
              src={api.pageImageUrl(doc.sha, p.n, 1.5)}
              alt={`Page ${p.n} of ${facts.title}`}
              loading="lazy"
              style={{ aspectRatio: `${p.width} / ${p.height}` }}
              className="w-full rounded-[2px] bg-white shadow-[0_0_0_1px_var(--hairline)]"
            />
            <figcaption className="font-mono text-xs text-fg-muted">
              Page {p.n} of {pages.length}
            </figcaption>
          </figure>
        ))
      )}
    </SideSheet>,
    document.body,
  )
}
