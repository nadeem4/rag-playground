import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import type { ChatCitation, ChatPayload, ChunkSet } from "@/api/types"
import { useFind } from "@/api/usePdf"
import { EmptyState } from "@/components/EmptyState"
import { citationHighlight, highlightWords } from "@/components/pdf/geometry"
import { PdfPageView } from "@/components/pdf/PdfPageView"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { chatStats, citationPage, citationSlot, quoteText, segmentKind, stopNote, unverifiedReason } from "./chat"
import "./inspectors.css"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * The chat answer (plan I-10). The answer reads as prose; the encoding stays
 * out of its way except where it matters:
 *
 *   cited          plain text, then a superscript number per citation, filled
 *                  with the cited chunk's hue (the hue that chunk has in every
 *                  other view)
 *   not verified   the same number with NO fill and a dashed outline: a pointer
 *                  whose quote did not check out never looks like one that did
 *   not grounded   secondary ink and a dashed underline, the mark the Chunk
 *                  inspector gives text no chunk covers. One mark, one meaning:
 *                  no source behind this text
 *
 * Clicking a number opens the page it cites, with the quote found on it.
 */

export function ChatInspector({ payload, status, chunkSet }: { payload?: ChatPayload; status?: InspectorStatus; chunkSet?: ChunkSet }) {
  const screen = statusScreen(status, "answer")
  if (screen) return <Frame><div className="bg-surface">{screen}</div></Frame>
  if (!payload) {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No answer yet">Run Chat to answer the question from the retrieved chunks.</EmptyState>
        </div>
      </Frame>
    )
  }
  return <ChatView payload={payload} chunkSet={chunkSet} />
}

function toneOf(slot: number | null): CSSProperties {
  return (
    slot === null
      ? { "--tone": "var(--surface-hover)", "--tone-text": "var(--text-primary)", "--tone-mark": "var(--text-secondary)" }
      : { "--tone": `var(--chunk-${slot})`, "--tone-text": `var(--chunk-${slot}-text)`, "--tone-mark": `var(--chunk-${slot})` }
  ) as CSSProperties
}

function ChatView({ payload, chunkSet }: { payload: ChatPayload; chunkSet?: ChunkSet }) {
  const [open, setOpen] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const pdfRef = useRef<HTMLDivElement>(null)
  const byN = new Map(payload.citations.map((c) => [c.n, c]))
  const stats = chatStats(payload)
  const note = stopNote(payload.stop_reason, payload.answer.every((s) => !s.text.trim()))
  const current = open === null ? undefined : byN.get(open)
  const place = current ? citationPage(current, chunkSet) : null

  // A discrete click: bring the page, or the citation when it has no page, into view.
  useEffect(() => {
    if (open === null) return
    const el = place ? pdfRef.current : listRef.current?.querySelector<HTMLElement>(`[data-citation="${open}"]`)
    el?.scrollIntoView?.({ block: "nearest" })
  }, [open, place])

  return (
    <Frame data-chat-inspector="">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface-elevated px-3 py-2">
        <Fact id="model" value={payload.model} label="model" />
        <Fact id="input" value={fmt(payload.usage?.input_tokens ?? 0)} label="tokens in" />
        <Fact id="output" value={fmt(payload.usage?.output_tokens ?? 0)} label="tokens out" />
        <Fact id="citations" value={fmt(stats.citations)} label={stats.citations === 1 ? "citation" : "citations"} />
        {stats.unverified ? <Fact id="unverified" value={fmt(stats.unverified)} label="not verified" /> : null}
        <Fact id="ungrounded" value={`${stats.ungrounded} of ${stats.segments}`} label="passages not tied to a source" />
        {payload.stop_reason ? <span className="font-mono text-xs text-fg-muted">{payload.stop_reason}</span> : null}
      </div>

      <div className="flex flex-col gap-1 bg-surface px-3 py-2">
        <span className="meta">question</span>
        <p className="max-w-[82ch] text-sm text-fg">{payload.question}</p>
      </div>

      <div className="flex flex-col gap-2 bg-surface px-3 py-3">
        {note ? (
          <p role="status" data-testid="chat-note" className={cn("text-sm", payload.stop_reason === "refusal" ? "font-medium text-fg" : "text-fg-muted")}>
            {note}
          </p>
        ) : null}
        <p data-answer="" className="max-w-[82ch] text-base leading-[1.65] whitespace-pre-wrap text-fg">
          {payload.answer.map((seg, k) => {
            const kind = segmentKind(seg)
            if (kind === "ungrounded") {
              return (
                <span key={k} data-segment="ungrounded" className="chat-ungrounded" title="Not tied to a source">
                  {seg.text}
                </span>
              )
            }
            if (kind === "plain") return <span key={k}>{seg.text}</span>
            return (
              <span key={k} data-segment="cited">
                {seg.text}
                {seg.citations.map((n) => (
                  <CiteMark key={n} n={n} citation={byN.get(n)} chunkSet={chunkSet} selected={open === n} onOpen={() => setOpen(n)} />
                ))}
              </span>
            )
          })}
        </p>
      </div>

      <Legend />

      {payload.citations.length ? (
        <ol ref={listRef} aria-label="Citations" className="flex flex-col bg-surface">
          {payload.citations.map((c) => (
            <CitationRow key={c.n} c={c} chunkSet={chunkSet} selected={open === c.n} onOpen={() => setOpen(c.n)} />
          ))}
        </ol>
      ) : (
        <div className="bg-surface">
          <EmptyState title="No citations">Nothing in this answer points to a source.</EmptyState>
        </div>
      )}

      {current && place ? (
        <div ref={pdfRef}>
          <CitationInPdf key={current.n} c={current} page={place.page} fromChunk={place.from === "chunk"} chunkSet={chunkSet} onClose={() => setOpen(null)} />
        </div>
      ) : null}
    </Frame>
  )
}

function Fact({ value, label, id }: { value: ReactNode; label: string; id: string }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span data-testid={`chat-${id}`} className="font-mono text-sm text-fg tabular-nums">
        {value}
      </span>
      <span className="text-xs text-fg-muted">{label}</span>
    </span>
  )
}

function CiteMark({
  n,
  citation,
  chunkSet,
  selected,
  onOpen,
}: {
  n: number
  citation?: ChatCitation
  chunkSet?: ChunkSet
  selected: boolean
  onOpen: () => void
}) {
  if (!citation) {
    return (
      <sup className="chat-sup">
        <span className="chat-cite font-mono" data-cite={n} data-missing="" title="This number is not in the citation list">
          {n}
        </span>
      </sup>
    )
  }
  return (
    <sup className="chat-sup">
      <button
        type="button"
        data-cite={n}
        data-verified={citation.verified ? "" : undefined}
        aria-pressed={selected}
        aria-label={`Citation ${n}${citation.verified ? "" : ", not verified"}`}
        title={citation.verified ? `Citation ${n}` : `Citation ${n}, not verified`}
        onClick={onOpen}
        className="chat-cite font-mono"
        style={toneOf(citationSlot(citation, chunkSet))}
      >
        {n}
      </button>
    </sup>
  )
}

function Legend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface px-3 py-2 text-xs text-fg-muted">
      <span className="flex items-center gap-1">
        <span aria-hidden className="chat-cite font-mono" data-verified="" style={toneOf(null)}>
          1
        </span>
        verified citation
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className="chat-cite font-mono" style={toneOf(null)}>
          1
        </span>
        citation not verified
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className="chat-ungrounded">
          text
        </span>
        not tied to a source
      </span>
    </p>
  )
}

function CitationRow({ c, chunkSet, selected, onOpen }: { c: ChatCitation; chunkSet?: ChunkSet; selected: boolean; onOpen: () => void }) {
  const place = citationPage(c, chunkSet)
  return (
    <li
      data-citation={c.n}
      data-verified={c.verified ? "" : undefined}
      className={cn("chat-row grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 border-t border-hairline px-3 py-2", selected && "bg-selection")}
    >
      <span className="chat-cite justify-self-start font-mono" data-verified={c.verified ? "" : undefined} style={toneOf(citationSlot(c, chunkSet))}>
        {c.n}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <q className="chat-quote max-w-[82ch] text-sm text-fg">{quoteText(c.cited_text)}</q>
        <p className="flex flex-wrap gap-x-3 font-mono text-2xs text-fg-muted">
          <span className={c.verified ? "text-fg" : undefined}>{c.verified ? "verified" : "not verified"}</span>
          {c.chunk_id ? <span title={c.chunk_id}>chunk {c.chunk_id.slice(0, 8)}</span> : <span>not in the hits</span>}
          {c.doc_start !== null && c.doc_end !== null ? (
            <span>
              chars {c.doc_start}-{c.doc_end}
            </span>
          ) : null}
        </p>
        {!c.verified ? <p className="text-xs text-fg-muted">{unverifiedReason(c)}</p> : null}
        {c.page === null ? <p className="text-xs text-fg-muted">Location not found in the page layout.</p> : null}
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="font-mono text-xs text-fg tabular-nums" data-testid="citation-page">
          {c.page !== null ? `p. ${c.page}` : place ? `p. ${place.page}?` : "no page"}
        </span>
        {place ? (
          <Button variant="outline" size="sm" onClick={onOpen}>
            Show in PDF
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The cited page with the quote found on it. The page search runs on the
 * server (pdfium); when it finds nothing, the whole element the citation came
 * from stands in, drawn dashed, and the notice says which one is shown.
 */
function CitationInPdf({
  c,
  page,
  fromChunk,
  chunkSet,
  onClose,
}: {
  c: ChatCitation
  page: number
  fromChunk: boolean
  chunkSet?: ChunkSet
  onClose: () => void
}) {
  const find = useFind(c.source_sha, page, quoteText(c.cited_text))
  const h = find.kind === "loading" ? null : citationHighlight(find.kind === "ready" ? find.data : null, c)
  const prefix = fromChunk ? `Location not found in the page layout. Searched p. ${page}, where its chunk starts. ` : ""
  let notice: string
  if (find.kind === "loading") notice = `${prefix}Looking for the cited text on p. ${page}.`
  else if (find.kind === "error") notice = `${prefix}Could not search the page (${find.message}). ${highlightWords(h!)}`
  else notice = prefix + highlightWords(h!)

  return (
    <div data-highlight-how={h?.how ?? "loading"}>
      <PdfPageView
        sha={c.source_sha}
        initialPage={page}
        highlights={(h?.rects ?? []).map((rect) => ({ page, rect, approximate: h?.how === "element" }))}
        slot={citationSlot(c, chunkSet)}
        title={`Citation ${c.n}`}
        notice={notice}
        onClose={onClose}
      />
    </div>
  )
}
