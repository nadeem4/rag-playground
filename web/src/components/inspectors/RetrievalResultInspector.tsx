import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react"

import type { ChunkSet, ParsedDoc, RetrievalResult } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { ElementsInPdf } from "@/components/pdf/ElementsInPdf"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { cn } from "@/lib/utils"

import "./inspectors.css"
import { EvidenceSlip } from "./EvidenceSlip"
import {
  componentKeys,
  layoutHits,
  pdfTarget,
  rowsFromResult,
  rowsFromSearch,
  scoreKey,
  sectionOf,
  type HitLayout,
  type HitRowData,
  type SearchOutput,
  type SlipSide,
} from "./hits"
import { useSpineLayout } from "./spine"
import { chunkSlot } from "./spans"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * Ranked hits, and where in the document they came from.
 *
 * The list, one evidence slip per hit (EvidenceSlip): the piece's swatch, a
 * finding line saying its place and where a reranker moved it from, the
 * ORIGINAL chunk text in the document voice, and a meta line (page, section,
 * the scores in mono each with its scale named, `RRF 0.0328`, Show in PDF).
 *
 * The document (when the upstream chunk set is passed): the position spine of
 * contract §9 with one band per hit, labelled with its rank, at the hit's true
 * offsets; the hit text painted in its chunk's hue, the same hue the Chunk
 * inspector gives that chunk, so one chunk is one colour everywhere.
 */

export interface RetrievalViewProps {
  rows: HitRowData[]
  chunkSet?: ChunkSet
  /** Facts for the summary strip, already worded. */
  facts: ReactNode
  /** False drops the document, for narrow side-by-side columns. */
  showDetail?: boolean
  /** The parsed document the chunks were cut from: enables "Show in PDF". */
  doc?: ParsedDoc
  /**
   * Which list this is: one list (the default), or the search or reranked side
   * of the comparison. The search side says each piece's place in search; the
   * reranked side says where each moved from, and puts the pieces it did not
   * keep after the kept ones.
   */
  side?: ListSide
  /** On the reranked side: the chunk ids the reranker kept. A row outside it is a Not kept slip. */
  kept?: ReadonlySet<string>
  /** On the reranked side: the keep limit. A row ranked past it is a Not kept slip. */
  keepLimit?: number
  /** On the reranked side: the reranker's transform key, so a Not kept slip can say why it was left out. */
  reranker?: string
  /**
   * True sets the list flat on the page (spec section 2: results carry no card
   * boxes): no bordered frame, and the facts as a plain line, not a tinted strip.
   * The Build inspector keeps its frame, which is the inspector's own chrome.
   */
  flat?: boolean
  /**
   * True when this list is new: its rows fade in and rise (motion 3). Read once,
   * when the list mounts, so a rerender never cuts the motion short; a caller
   * keys the list on its artifact id to get a new one.
   */
  enter?: boolean
  /** True in the comparison: every slip is compact, its passage clamped with Show more. */
  compact?: boolean
  /** The chunk id the linked highlight has lit: its slip takes the raised look. */
  lit?: string | null
}

export function RetrievalResultInspector({
  result,
  status,
  chunkSet,
  showDetail = true,
  doc,
}: {
  result?: RetrievalResult
  status?: InspectorStatus
  chunkSet?: ChunkSet
  showDetail?: boolean
  doc?: ParsedDoc
}) {
  const screen = statusScreen(status, "retrieval result")
  if (screen) return <Frame><div className="bg-surface">{screen}</div></Frame>
  if (!result) {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No retrieval result yet">Run Retrieve to rank the index against the question.</EmptyState>
        </div>
      </Frame>
    )
  }
  const rows = rowsFromResult(result)
  const retrievers = [...new Set(rows.map((r) => r.retriever).filter(Boolean))]
  const timings = Object.entries(result.timings_ms ?? {})
  return (
    <RetrievalView
      rows={rows}
      chunkSet={chunkSet}
      showDetail={showDetail}
      doc={doc}
      facts={
        <>
          <Fact value={fmt(rows.length)} label={rows.length === 1 ? "hit" : "hits"} id="hits" />
          <Fact value={fmt(result.total_candidates)} label="candidates" id="candidates" />
          <Fact value={fmt(result.fetch_k)} label="fetch_k" id="fetch-k" />
          {retrievers.length ? <span className="font-mono text-xs text-fg-muted">{retrievers.join(", ")}</span> : null}
          {timings.length ? (
            <span className="font-mono text-xs text-fg-muted">{timings.map(([k, v]) => `${k} ${fmtMs(v)}`).join("  ")}</span>
          ) : null}
        </>
      }
    />
  )
}

export function SearchOutputInspector({
  output,
  chunkSet,
  showDetail = true,
  doc,
}: {
  output: SearchOutput
  chunkSet?: ChunkSet
  showDetail?: boolean
  doc?: ParsedDoc
}) {
  const rows = rowsFromSearch(output)
  const total = output.payload.total_candidates
  return (
    <RetrievalView
      rows={rows}
      chunkSet={chunkSet}
      showDetail={showDetail}
      doc={doc}
      facts={
        <>
          <Fact value={fmt(rows.length)} label={rows.length === 1 ? "result" : "results"} id="hits" />
          {typeof total === "number" ? <Fact value={fmt(total)} label="candidates" id="candidates" /> : null}
          <span className="font-mono text-xs text-fg-muted">{output.kind}</span>
        </>
      }
    />
  )
}

function Fact({ value, label, id }: { value: ReactNode; label: string; id: string }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span data-testid={`fact-${id}`} className="font-mono text-sm text-fg tabular-nums">
        {value}
      </span>
      <span className="text-xs text-fg-muted">{label}</span>
    </span>
  )
}

// ---------------------------------------------------------------- layout --

// One spine lane is `--lane` wide (inspectors.css): a 4px band plus a 2px gap,
// or a whole 24px hit box on a touch screen.
const LABEL = 20 // px for the rank numbers on the spine

export type ListSide = "single" | "search" | "reranked"

export function RetrievalView({ rows, chunkSet, facts, showDetail = true, doc, side = "single", kept, keepLimit, reranker, flat = false, enter = false, compact = false, lit = null }: RetrievalViewProps) {
  const Box = flat ? FlatFrame : Frame
  const [entering] = useState(enter)
  const rootRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [pdfRow, setPdfRow] = useState<number | null>(null)
  // A discrete click opens the page below the list: bring it into view once.
  useEffect(() => {
    if (pdfRow !== null) pdfRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [pdfRow])
  const target = pdfRow === null || !rows[pdfRow] ? null : pdfTarget(rows[pdfRow], chunkSet?.chunks)
  const canPdf = (row: number) => doc !== undefined && pdfTarget(rows[row], chunkSet?.chunks) !== null

  const keys = useMemo(() => componentKeys(rows), [rows])
  const layout = useMemo(
    () => (chunkSet && showDetail ? layoutHits(chunkSet.source_text, chunkSet.chunks, rows) : null),
    [chunkSet, rows, showDetail],
  )
  const markOf = useMemo(() => new Map(layout?.marks.map((m, k) => [m.row, k]) ?? []), [layout])
  // A Search row carries no heading path; the chunk set behind it does.
  const sections = useMemo(() => new Map(chunkSet?.chunks.map((c) => [c.id, sectionOf(c.heading_path)]) ?? []), [chunkSet])
  // The piece's index in its chunk set is its number and colour everywhere; the row's own ordinal when the set is not at hand.
  const pieces = useMemo(() => new Map(chunkSet?.chunks.map((c, i) => [c.id, i]) ?? []), [chunkSet])

  // Hover: a data attribute written through the ref, never state (contract §7).
  const onPointerOver = (e: PointerEvent) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-hits]")
    const root = rootRef.current
    if (!root) return
    if (hit?.dataset.hits) root.dataset.hover = hit.dataset.hits
    else delete root.dataset.hover
  }
  const onPointerLeave = () => {
    if (rootRef.current) delete rootRef.current.dataset.hover
  }

  // A discrete click: select the hit and bring its text into the document box.
  const select = (row: number) => {
    setSelected(row)
    const k = markOf.get(row)
    const first = k === undefined ? undefined : layout?.marks[k].first
    const el = first === undefined ? null : docRef.current?.querySelector<HTMLElement>(`[data-target="${first}"]`)
    // Scrolls the nearest scrolling box (the inspector panel), never the page.
    el?.scrollIntoView?.({ block: "start" })
  }

  const hoverRules = useMemo(
    () => (layout?.marks ?? []).map((_, k) => `[data-hover~="h${k}"] .ri-mark.h${k}{opacity:1}`).join(""),
    [layout],
  )

  if (rows.length === 0) {
    return (
      <Box>
        <Summary flat={flat}>{facts}</Summary>
        <div className="bg-surface">
          <EmptyState title="No hits">
            The retriever returned nothing for this question. Check that the question is not empty and that the index has chunks.
          </EmptyState>
        </div>
      </Box>
    )
  }

  return (
    <Box>
      {/* The movement count is the reranker's run note, the sub line above the results: never repeated here. */}
      <Summary flat={flat}>{facts}</Summary>
      <div ref={rootRef} className="ri" onPointerOver={onPointerOver} onPointerLeave={onPointerLeave}>
        <style>{hoverRules}</style>
        <div className="ri-body" data-doc={layout ? "" : undefined}>
          <HitList
            rows={rows}
            keys={keys}
            markOf={markOf}
            selected={selected}
            onSelect={select}
            onShowPdf={doc ? setPdfRow : undefined}
            canPdf={canPdf}
            showRetriever={new Set(rows.map((r) => r.retriever)).size > 1}
            kept={kept}
            keepLimit={keepLimit}
            reranker={reranker}
            side={side}
            enter={entering}
            compact={compact}
            lit={lit}
            pieceOf={(r) => (chunkSet ? (pieces.get(r.chunk_id) ?? null) : r.ordinal)}
            sectionOf={(r) => r.section ?? sections.get(r.chunk_id) ?? null}
          />
          {layout && chunkSet ? (
            <HitDocument layout={layout} rows={rows} source={chunkSet.source_text} selected={selected} onSelect={select} scrollRef={docRef} />
          ) : null}
        </div>
      </div>
      {doc && target && pdfRow !== null ? (
        <div ref={pdfRef}>
          <ElementsInPdf
            doc={doc}
            elementIds={target.elementIds}
            pageSpan={target.pageSpan}
            slot={target.chunkIndex === null ? null : chunkSlot(target.chunkIndex)}
            title={`Rank ${rows[pdfRow].rank}`}
            onClose={() => setPdfRow(null)}
          />
        </div>
      ) : null}
    </Box>
  )
}

/** A flat list: no border, no radius, no tinted gaps. */
function FlatFrame({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1">{children}</div>
}

/** The facts strip, or a plain line when the list is flat; none when there are no facts to state. */
function Summary({ children, flat = false }: { children: ReactNode; flat?: boolean }) {
  if (children === null || children === undefined || children === false) return null
  return (
    <div data-summary="" className={cn("flex flex-wrap items-baseline gap-x-4 gap-y-1", flat ? "px-1" : "bg-surface-elevated px-3 py-2")}>
      {children}
    </div>
  )
}

// ------------------------------------------------------------------ list --

/*
 * One evidence slip per hit (EvidenceSlip), a column of them 4px apart with no
 * rule between. Which side a slip is on follows the list's `side`; one list
 * a reranker reordered still says where each piece moved from. On the
 * reranked side a piece past the keep limit, or outside the kept set, is a Not
 * kept slip, and those come after the kept ones. A slip is a tab stop, and
 * Enter or Space selects it as a click does.
 */

function HitList({
  rows,
  keys,
  markOf,
  selected,
  onSelect,
  onShowPdf,
  canPdf,
  showRetriever,
  kept,
  keepLimit,
  reranker,
  side: list,
  enter,
  compact,
  lit,
  pieceOf,
  sectionOf: section,
}: {
  rows: HitRowData[]
  keys: string[]
  markOf: Map<number, number>
  selected: number | null
  onSelect: (row: number) => void
  onShowPdf?: (row: number) => void
  canPdf: (row: number) => boolean
  /** Per row only when the rows mix retrievers; otherwise the summary names it once. */
  showRetriever: boolean
  kept?: ReadonlySet<string>
  keepLimit?: number
  reranker?: string
  side: ListSide
  enter: boolean
  compact: boolean
  lit: string | null
  pieceOf: (row: HitRowData) => number | null
  sectionOf: (row: HitRowData) => string | null
}) {
  const scale = scoreKey(rows)
  const moved = rows.some((r) => r.prior_rank != null)
  const reranked = list === "reranked"
  const dropped = (r: HitRowData) => reranked && ((keepLimit !== undefined && r.rank > keepLimit) || (kept !== undefined && !kept.has(r.chunk_id)))
  const side = (r: HitRowData): SlipSide => (dropped(r) ? "notKept" : list === "single" && moved ? "reranked" : list)
  // Kept slips first, in the order given; Not kept slips after them, in search order.
  const order = rows.map((r, i) => ({ r, i }))
  const shown = [
    ...order.filter(({ r }) => !dropped(r)),
    ...order.filter(({ r }) => dropped(r)).sort((a, b) => (a.r.prior_rank ?? a.r.rank) - (b.r.prior_rank ?? b.r.rank)),
  ]
  const limit = keepLimit ?? (kept ? kept.size : undefined)
  return (
    <div className="ri-list flex min-w-0 flex-col gap-1 bg-surface p-1" role="list" aria-label="Ranked hits">
      {shown.map(({ r, i }, n) => {
        const k = markOf.get(i)
        const s = side(r)
        return (
          <EvidenceSlip
            key={`${r.chunk_id}-${i}`}
            role="listitem"
            row={r}
            side={s}
            piece={pieceOf(r)}
            scaleKey={scale}
            keys={keys}
            keepLimit={limit}
            reranker={reranker}
            clamp={s === "search" && selected !== i}
            compact={compact}
            lit={lit === r.chunk_id}
            section={section(r)}
            retriever={showRetriever && r.retriever ? r.retriever : null}
            onShowInPdf={onShowPdf && canPdf(i) ? () => onShowPdf(i) : undefined}
            data-hit-row={r.rank}
            data-flip-key={r.chunk_id}
            data-hits={k === undefined ? undefined : `h${k}`}
            data-enter={enter ? "" : undefined}
            style={enter ? ({ "--i": Math.min(n, 4) } as CSSProperties) : undefined}
            // In the comparison a slip selects nothing (no document beside it): a tap there is the linked highlight's.
            onClick={compact ? undefined : () => onSelect(i)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
              e.preventDefault()
              if (!compact) onSelect(i)
            }}
            className={cn(!compact && "cursor-pointer", k !== undefined && `ri-mark h${k}`, selected === i && "bg-selection hover:bg-selection focus-visible:bg-selection focus-within:bg-selection")}
          />
        )
      })}
    </div>
  )
}

// -------------------------------------------------------------- document --

function HitDocument({
  layout,
  rows,
  source,
  selected,
  onSelect,
  scrollRef,
}: {
  layout: HitLayout
  rows: HitRowData[]
  source: string
  selected: number | null
  onSelect: (row: number) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const measureRef = useRef<HTMLDivElement>(null)
  useSpineLayout(measureRef, [layout])
  const lanes = Math.max(1, ...layout.marks.map((m) => m.lane + 1))
  const spineWidth = `calc(${LABEL + 4}px + ${lanes} * var(--lane))`

  return (
    <div className="flex min-w-0 flex-col bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-hairline px-3 py-1">
        <span className="meta">Hits in the document</span>
        {layout.unplaced.length ? (
          <span className="text-xs text-fg-muted">
            {layout.unplaced.length === 1 ? `Rank ${layout.unplaced[0]} is` : `Ranks ${layout.unplaced.join(", ")} are`} from chunks not in this
            chunk set
          </span>
        ) : null}
      </div>
      <div ref={scrollRef} className="min-w-0">
        <div ref={measureRef} className="grid gap-3 p-3" style={{ gridTemplateColumns: `${spineWidth} minmax(0, 82ch)` }}>
          <div data-spine="" aria-label="Hits on the position spine" className="relative">
            <span aria-hidden className="absolute top-0 bottom-0 w-px bg-hairline" style={{ left: LABEL + 1 }} />
            {layout.marks.map((m, k) =>
              m.first === -1 ? null : (
                <Fragment key={k}>
                  <span
                    data-tick={m.rank}
                    data-hits={`h${k}`}
                    data-first={m.first}
                    data-last={m.first}
                    className={cn("ri-mark absolute left-0 text-right font-mono text-2xs leading-4 font-medium text-fg tabular-nums", `h${k}`)}
                    style={{ width: LABEL - 4 }}
                  >
                    {m.rank}
                  </span>
                  <button
                    type="button"
                    data-band=""
                    data-hits={`h${k}`}
                    data-first={m.first}
                    data-last={m.last}
                    aria-label={`Rank ${m.rank}, characters ${m.start} to ${m.end}`}
                    aria-pressed={selected === m.row}
                    onClick={() => onSelect(m.row)}
                    className={cn("ri-mark ci-band absolute w-[4px] cursor-pointer p-0", `h${k}`, selected === m.row && "sel")}
                    style={{ left: `calc(${LABEL + 4}px + ${m.lane} * var(--lane))`, background: `var(--chunk-${chunkSlot(m.chunkIndex)})` }}
                  />
                </Fragment>
              ),
            )}
          </div>
          <div data-reading="" className="min-w-0 font-serif text-base leading-[1.55] break-words whitespace-pre-wrap text-fg">
            {layout.segments.map((s, j) => {
              const text = source.slice(s.start, s.end)
              if (s.chunks.length === 0) {
                return (
                  <span key={j} data-target={j} className="text-fg-muted">
                    {text}
                  </span>
                )
              }
              const marks = s.chunks.map((k) => layout.marks[k])
              const style: Record<string, string> = {
                "--a": `var(--chunk-${chunkSlot(marks[0].chunkIndex)})`,
                "--a-text": `var(--chunk-${chunkSlot(marks[0].chunkIndex)}-text)`,
              }
              if (marks.length > 1) style["--b"] = `var(--chunk-${chunkSlot(marks[1].chunkIndex)})`
              return (
                <span
                  key={j}
                  data-target={j}
                  data-hits={s.chunks.map((k) => `h${k}`).join(" ")}
                  data-overlap={marks.length > 1 ? "" : undefined}
                  onClick={() => onSelect(marks[0].row)}
                  title={`Rank ${marks.map((m) => m.rank).join(", ")}`}
                  className={cn(
                    "ci-seg ri-mark cursor-pointer",
                    s.chunks.map((k) => `h${k}`),
                    selected !== null && marks.some((m) => m.row === selected) && "sel",
                  )}
                  style={style as CSSProperties}
                >
                  {text}
                </span>
              )
            })}
          </div>
        </div>
      </div>
      <p className="sr-only">
        {rows.length} hits; {layout.marks.length} placed on the document.
      </p>
    </div>
  )
}
