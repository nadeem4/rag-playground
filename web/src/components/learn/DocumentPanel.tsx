import { useEffect, useRef, useState, type ReactNode } from "react"

import { api } from "@/api/client"
import type { LearnDocument } from "@/api/types"
import { useFind } from "@/api/usePdf"
import { PdfPageView } from "@/components/pdf/PdfPageView"
import { cn } from "@/lib/utils"

/**
 * "The document", beside every lesson step. A learner should see what the
 * sample says while a lesson talks about chunk 5. Pages are the real rendered
 * PDF pages, through the same viewer "Show in PDF" uses. Text is the parsed
 * text the steps work on, as the server rendered it.
 *
 * When the step is about one sentence, that sentence is marked: boxed on its
 * page, and highlighted in the parsed text.
 */

type View = "pages" | "text"

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; doc: LearnDocument }

/** The page the lesson sentences live on. A box is only ever drawn there. */
const SENTENCE_PAGE = 1

export function caption(doc: LearnDocument): string {
  const pages = doc.page_count === 1 ? "1 page" : `${doc.page_count} pages`
  return `${doc.filename}, ${pages} of notes about how chunking works.`
}

/** The sentence as it sits in the parsed text, where line breaks may differ. */
function findSentence(text: string, sentence: string): [number, number] | null {
  const pattern = sentence
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+")
  const m = new RegExp(pattern).exec(text)
  return m ? [m.index, m.index + m[0].length] : null
}

/** The parsed text with the step's sentence marked, and scrolled to. */
function ParsedText({ text, sentence }: { text: string; sentence: string | null }) {
  const mark = useRef<HTMLElement | null>(null)
  const at = sentence ? findSentence(text, sentence) : null

  useEffect(() => {
    const el = mark.current
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
  }, [sentence])

  let body: ReactNode = text
  if (at) {
    body = (
      <>
        {text.slice(0, at[0])}
        <mark ref={mark} className="lesson-mark">
          {text.slice(at[0], at[1])}
        </mark>
        {text.slice(at[1])}
      </>
    )
  }
  return (
    <pre className="m-0 max-h-[420px] min-w-0 overflow-auto rounded-panel border border-hairline bg-surface-elevated p-3 font-mono text-xs leading-[1.7] break-words whitespace-pre-wrap text-fg">
      {body}
    </pre>
  )
}

export function DocumentPanel({ sha, highlight = null }: { sha: string | null; highlight?: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" })
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

  const found = useFind(sha ?? "", sha && highlight ? SENTENCE_PAGE : null, highlight)
  const rects = found.kind === "ready" ? found.data.rects : []

  return (
    <section aria-label="The document" className="flex flex-col rounded-panel border border-hairline bg-surface">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
        <span className="text-sm font-semibold">The document</span>
        <span className="text-sm text-fg-muted">
          {state.kind === "ready" ? caption(state.doc) : state.kind === "loading" ? "Loading the sample document" : "The sample document could not be loaded."}
        </span>
      </div>
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
              {highlight
                ? "The sentence this step is about is marked. The steps work on the parsed text, not on the picture of the page."
                : "The steps work on the parsed text, not on the picture of the page."}
            </p>
            {view === "pages" ? (
              sha ? (
                <div className="min-w-0 overflow-hidden rounded-panel border border-hairline">
                  <PdfPageView
                    sha={sha}
                    initialPage={SENTENCE_PAGE}
                    highlights={rects.map((r) => ({ page: SENTENCE_PAGE, rect: r }))}
                    scale={0.75}
                    title={state.doc.filename}
                  />
                </div>
              ) : (
                <p className="m-0 text-sm text-fg-muted">The sample is not loaded yet, so its pages cannot be shown.</p>
              )
            ) : (
              <ParsedText text={state.doc.text} sentence={highlight} />
            )}
          </>
        )}
      </div>
    </section>
  )
}
