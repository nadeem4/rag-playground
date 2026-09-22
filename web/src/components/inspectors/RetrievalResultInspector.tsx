import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react"

import type { ChunkSet, ParsedDoc, RetrievalResult } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { ElementsInPdf } from "@/components/pdf/ElementsInPdf"
import { Button } from "@/components/ui/button"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { cn } from "@/lib/utils"

import "./inspectors.css"
import {
  barWidth,
  componentKeys,
  fmtScore,
  layoutHits,
  movement,
  pages,
  pdfTarget,
  rowsFromResult,
  rowsFromSearch,
  scaleMax,
  type HitLayout,
  type HitRowData,
  type SearchOutput,
} from "./hits"
import { useSpineLayout } from "./spine"
import { chunkSlot } from "./spans"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * Ranked hits, and where in the document they came from.
 *
 * The list: rank, the rank a reranker moved it from, the score, and one small
 * bar per component score (dense, bm25) on its own scale, drawn from a hairline
 * baseline with no track. Then the ORIGINAL chunk text.
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

const BAR = 40 // px, the longest score bar
const LANE = 6 // px per spine lane: a 4px band plus a 2px gap
const LABEL = 20 // px for the rank numbers on the spine

export function RetrievalView({ rows, chunkSet, facts, showDetail = true, doc }: RetrievalViewProps) {
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
  const moved = rows.filter((r) => movement(r).kind !== "none").length
  const reranked = rows.some((r) => r.prior_rank !== null)

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
      <Frame>
        <Summary>{facts}</Summary>
        <div className="bg-surface">
          <EmptyState title="No hits">
            The retriever returned nothing for this question. Check that the question is not empty and that the index has chunks.
          </EmptyState>
        </div>
      </Frame>
    )
  }

  return (
    <Frame>
      <Summary>
        {facts}
        {reranked ? (
          <span data-testid="fact-moved" className="text-xs text-fg-muted">
            rerank moved {moved} of {rows.length}
          </span>
        ) : null}
      </Summary>
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
    </Frame>
  )
}

function Summary({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface-elevated px-3 py-2">{children}</div>
}

// ------------------------------------------------------------------ list --

/**
 * Column template shared by the header and every row, so bars align: rank,
 * rank before rerank, score, then one bar column per component score. With no
 * components the score gets the single bar column, unlabelled beside its number.
 */
function columns(bars: number): CSSProperties {
  // The widths hold the mono text they carry: a 4 letter tracked column label
  // in the rank column, and a bar plus a five decimal score in each bar column.
  // Martian Mono is wider than a usual mono, so they were measured for it.
  return { gridTemplateColumns: `32px 44px 64px repeat(${bars}, ${BAR + 48}px)` }
}

function HitList({
  rows,
  keys,
  markOf,
  selected,
  onSelect,
  onShowPdf,
  canPdf,
  showRetriever,
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
}) {
  const scoreMax = scaleMax(rows.map((r) => r.score))
  const maxOf = Object.fromEntries(keys.map((k) => [k, scaleMax(rows.map((r) => r.component_scores[k]))]))
  const grid = columns(Math.max(1, keys.length))
  return (
    <div className="ri-list flex min-w-0 flex-col bg-surface" role="list" aria-label="Ranked hits">
      <div className="ri-grid border-b border-hairline px-3 py-1" style={grid} aria-hidden>
        <span className="meta text-right">rank</span>
        <span />
        <span className="meta text-right">score</span>
        {keys.length ? (
          keys.map((k) => (
            <span key={k} className="meta">
              {k}
            </span>
          ))
        ) : (
          <span />
        )}
      </div>
      {rows.map((r, i) => {
        const move = movement(r)
        const k = markOf.get(i)
        return (
          <div
            key={`${r.chunk_id}-${i}`}
            role="listitem"
            data-hit-row={r.rank}
            data-hits={k === undefined ? undefined : `h${k}`}
            onClick={() => onSelect(i)}
            className={cn(
              "ri-row flex cursor-pointer flex-col gap-1 border-b border-hairline px-3 py-2 last:border-b-0 hover:bg-surface-elevated",
              k !== undefined && `ri-mark h${k}`,
              selected === i && "bg-selection hover:bg-selection",
            )}
          >
            <div className="ri-grid items-baseline" style={grid}>
              <span className="text-right font-mono text-sm font-semibold text-fg tabular-nums">{r.rank}</span>
              <span
                data-testid="movement"
                title={move.kind === "none" ? undefined : `rank ${move.from} before rerank`}
                className={cn("font-mono text-xs", move.kind === "up" ? "font-semibold text-fg" : "text-fg-muted")}
              >
                {move.kind === "none" ? "" : move.text}
              </span>
              <span className="text-right font-mono text-sm text-fg tabular-nums">{fmtScore(r.score)}</span>
              {keys.length ? (
                keys.map((key) => <ScoreBar key={key} value={r.component_scores[key]} max={maxOf[key]} label />)
              ) : (
                <ScoreBar value={r.score} max={scoreMax} />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1 pl-[40px]">
              <p className="ri-snippet text-sm text-fg">{r.text}</p>
              <p className="flex flex-wrap gap-x-3 font-mono text-2xs text-fg-muted">
                {pages(r.page_span) ? <span>{pages(r.page_span)}</span> : null}
                {showRetriever && r.retriever ? <span>{r.retriever}</span> : null}
                <span title={r.chunk_id}>{r.chunk_id.slice(0, 8)}</span>
              </p>
              {onShowPdf && canPdf(i) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={(e) => {
                    e.stopPropagation()
                    onShowPdf(i)
                  }}
                >
                  Show in PDF
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A score bar: grows from a 1px hairline baseline, no filled track (contract
 * §11), the value printed at its tip in text ink. Absent means the hit was not
 * in that list, which is different from scoring zero, so it says so.
 */
function ScoreBar({ value, max, label = false }: { value: number | undefined; max: number; label?: boolean }) {
  const w = barWidth(value, max, BAR)
  if (value === undefined) {
    return <span className="font-mono text-2xs text-fg-muted">{label ? "not in list" : ""}</span>
  }
  return (
    <span className="flex items-center gap-1" data-bar={w}>
      <span aria-hidden className="flex items-center">
        <span className="block h-[12px] w-px shrink-0 bg-hairline" />
        <span className="block h-[6px] shrink-0" style={{ width: w, background: "var(--score-3)" }} />
      </span>
      {label ? <span className="font-mono text-2xs text-fg-muted tabular-nums">{fmtScore(value)}</span> : null}
    </span>
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
  const spineWidth = LABEL + 4 + lanes * LANE

  return (
    <div className="flex min-w-0 flex-col bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-hairline px-3 py-1">
        <span className="meta">hits in the document</span>
        {layout.unplaced.length ? (
          <span className="text-xs text-fg-muted">
            {layout.unplaced.length === 1 ? `Rank ${layout.unplaced[0]} is` : `Ranks ${layout.unplaced.join(", ")} are`} from chunks not in this
            chunk set
          </span>
        ) : null}
      </div>
      <div ref={scrollRef} className="min-w-0">
        <div ref={measureRef} className="grid gap-3 p-3" style={{ gridTemplateColumns: `${spineWidth}px minmax(0, 82ch)` }}>
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
                    className={cn("ri-mark absolute left-0 text-right font-mono text-2xs leading-4 font-semibold text-fg tabular-nums", `h${k}`)}
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
                    style={{ left: LABEL + 4 + m.lane * LANE, background: `var(--chunk-${chunkSlot(m.chunkIndex)})` }}
                  />
                </Fragment>
              ),
            )}
          </div>
          <div data-reading="" className="min-w-0 font-mono text-base leading-[1.65] break-words whitespace-pre-wrap text-fg">
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
