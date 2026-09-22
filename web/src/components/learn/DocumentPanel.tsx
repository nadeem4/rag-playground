import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import { api } from "@/api/client"
import type { LearnDocument } from "@/api/types"
import { PdfPageView } from "@/components/pdf/PdfPageView"
import { cn } from "@/lib/utils"
import { initialDocumentOpen, rememberDocumentOpen } from "@/state/documentPanel"

/**
 * "The document", at the top of every lesson. A learner should see what the
 * sample says before a lesson talks about chunk 5. Pages are the real rendered
 * PDF pages, through the same viewer "Show in PDF" uses. Text is the parsed
 * text the steps work on, as the server rendered it.
 */

type View = "pages" | "text"

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; doc: LearnDocument }

export function caption(doc: LearnDocument): string {
  const pages = doc.page_count === 1 ? "1 page" : `${doc.page_count} pages`
  return `${doc.filename}, ${pages} of notes about how chunking works.`
}

export function DocumentPanel({ sha }: { sha: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [open, setOpen] = useState(initialDocumentOpen)
  const [view, setView] = useState<View>("pages")

  useEffect(() => {
    let live = true
    api.learnDocument().then(
      (doc) => live && setState({ kind: "ready", doc }),
      (e: unknown) => live && setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    rememberDocumentOpen(next)
  }

  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section aria-label="The document" className="flex min-w-0 flex-col rounded-panel border border-hairline bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left"
      >
        <span className="flex items-baseline gap-2 text-sm font-semibold">
          <Chevron aria-hidden strokeWidth={1.75} className="size-[14px] self-center" />
          The document
        </span>
        <span className="text-sm text-fg-muted">
          {state.kind === "ready" ? caption(state.doc) : state.kind === "loading" ? "Loading the sample document" : "The sample document could not be loaded."}
        </span>
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col gap-3 border-t border-hairline p-3">
          {state.kind === "error" ? (
            <div role="alert" className="flex flex-col gap-1">
              <p className="m-0 text-sm font-medium text-danger">The sample document could not be loaded.</p>
              <p className="m-0 font-mono text-xs break-words text-fg-muted">{state.message}</p>
            </div>
          ) : state.kind === "loading" ? (
            <p role="status" className="m-0 text-sm text-fg-muted">
              Loading the sample document
            </p>
          ) : (
            <>
              <div role="tablist" aria-label="Views of the document" className="flex flex-wrap gap-2">
                {(["pages", "text"] as View[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    className={cn(
                      "h-control rounded-control border px-2 text-xs",
                      view === v ? "border-fg bg-fg text-surface" : "border-hairline bg-surface text-fg-muted hover:text-fg",
                    )}
                  >
                    {v === "pages" ? "Pages" : "Text"}
                  </button>
                ))}
              </div>
              <p className="m-0 max-w-[68ch] text-xs text-fg-muted">
                The steps work on the parsed text, not on the picture of the page.
              </p>
              {view === "pages" ? (
                sha ? (
                  <div className="min-w-0 overflow-hidden rounded-panel border border-hairline">
                    <PdfPageView sha={sha} initialPage={1} highlights={[]} scale={0.75} title={state.doc.filename} />
                  </div>
                ) : (
                  <p className="m-0 text-sm text-fg-muted">The sample is not loaded yet, so its pages cannot be shown.</p>
                )
              ) : (
                <pre className="m-0 max-h-[420px] max-w-[82ch] overflow-auto rounded-panel border border-hairline bg-surface-elevated p-3 font-mono text-sm leading-[1.65] break-words whitespace-pre-wrap text-fg">
                  {state.doc.text}
                </pre>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
