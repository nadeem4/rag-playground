import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react"

import type { ChunkSet, ParsedDoc, RetrievalResult } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { ElementsInPdf } from "@/components/pdf/ElementsInPdf"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { cn } from "@/lib/utils"

import "./inspectors.css"
import {
  badge,
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
  scaleName,
  scoreKey,
  sectionOf,
  type Badge,
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
 * The list, one row of evidence per hit: the rank, large, with the rank a
 * reranker moved it from; the ORIGINAL chunk text in the reading face; a where
 * line (page, section, Show in PDF); and on the right the scores in mono, each
 * with its scale named (`RRF 0.0328`, `Dense 0.254`), each component with a
 * small bar on its own scale, drawn from a hairline baseline with no track.
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
  /** Chunk ids a reranker kept: the rows NOT in it say `Not kept` (the Ask panel's search order column). */
  kept?: ReadonlySet<string>
  /** True shows each row's movement as a tinted badge, `up from #6`, instead of `was 6`. */
  badges?: boolean
  /**
   * True when this list is new: its rows fade in and rise (motion 3). Read once,
   * when the list mounts, so a rerender never cuts the motion short; a caller
   * keys the list on its artifact id to get a new one.
   */
  enter?: boolean
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
// One spine lane is `--lane` wide (inspectors.css): a 4px band plus a 2px gap,
// or a whole 24px hit box on a touch screen.
const LABEL = 20 // px for the rank numbers on the spine

export function RetrievalView({ rows, chunkSet, facts, showDetail = true, doc, kept, badges = false, enter = false }: RetrievalViewProps) {
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
      {/* The movement count is the reranker's run note, under the list: never repeated here. */}
      <Summary>{facts}</Summary>
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
            badges={badges}
            enter={entering}
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
    </Frame>
  )
}

function Summary({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface-elevated px-3 py-2">{children}</div>
}

// ------------------------------------------------------------------ list --

/*
 * The list is one grid and every row a subgrid of it (inspectors.css), so the
 * columns are sized by their content, the widest row's, and still line up from
 * row to row: rank, the passage, then the score cluster's name, value and bar.
 * No width is measured for a font. Below 600px of list the scores wrap under
 * the passage instead.
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
  badges,
  enter,
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
  badges: boolean
  enter: boolean
  sectionOf: (row: HitRowData) => string | null
}) {
  const scoreMax = scaleMax(rows.map((r) => r.score))
  const maxOf = Object.fromEntries(keys.map((k) => [k, scaleMax(rows.map((r) => r.component_scores[k]))]))
  const fused = scaleName(scoreKey(rows))
  return (
    <div className="ri-list min-w-0 bg-surface" role="list" aria-label="Ranked hits">
      <div className="ri-head border-b border-hairline px-3 py-1" aria-hidden>
        <span className="ri-rank meta text-right">Rank</span>
        <span className="ri-scores-head meta">Score</span>
      </div>
      {rows.map((r, i) => {
        const move = movement(r)
        const k = markOf.get(i)
        const tag = badges ? badge(r) : null
        const dropped = kept !== undefined && !kept.has(r.chunk_id)
        const where = [pages(r.page_span), section(r), showRetriever && r.retriever ? r.retriever : null]
        return (
          <div
            key={`${r.chunk_id}-${i}`}
            role="listitem"
            data-hit-row={r.rank}
            data-flip-key={r.chunk_id}
            data-hits={k === undefined ? undefined : `h${k}`}
            data-enter={enter ? "" : undefined}
            style={enter ? ({ "--i": Math.min(i, 4) } as CSSProperties) : undefined}
            title={`Piece ${r.chunk_id.slice(0, 8)}`}
            onClick={() => onSelect(i)}
            className={cn(
              "ri-row cursor-pointer border-b border-hairline px-3 py-2 last:border-b-0 hover:bg-surface-elevated",
              k !== undefined && `ri-mark h${k}`,
              selected === i && "bg-selection hover:bg-selection",
            )}
          >
            <div className="ri-rank flex flex-col items-end">
              <span data-testid="rank" className="text-lg font-semibold text-fg tabular-nums">
                {r.rank}
              </span>
              <span
                data-testid="movement"
                title={move.kind === "none" ? undefined : `rank ${move.from} before rerank`}
                className={cn("font-mono text-2xs whitespace-nowrap", move.kind === "up" ? "font-medium text-fg" : "text-fg-muted")}
              >
                {move.kind === "none" || badges ? "" : move.text}
              </span>
            </div>
            <div className="ri-main flex min-w-0 flex-col gap-1">
              {tag || dropped ? (
                <p className="flex flex-wrap items-center gap-2">
                  {tag ? (
                    <span data-testid="badge" data-badge={tag.kind} className="rounded-control px-1 font-mono text-2xs" style={BADGE_TINT[tag.kind]}>
                      {tag.text}
                    </span>
                  ) : null}
                  {dropped ? <span className="meta">Not kept</span> : null}
                </p>
              ) : null}
              <p className="ri-snippet font-sans text-base text-fg">{r.text}</p>
              <p data-testid="where" className="flex flex-wrap items-baseline gap-x-3 text-xs text-fg-muted">
                {where[0] ? <span className="font-mono tabular-nums">{where[0]}</span> : null}
                {where[1] ? <span>{where[1]}</span> : null}
                {where[2] ? <span className="font-mono">{where[2]}</span> : null}
                {onShowPdf && canPdf(i) ? (
                  <button
                    type="button"
                    className="cursor-pointer rounded-control font-medium text-primary underline-offset-4 transition-colors duration-(--dur-fast) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onShowPdf(i)
                    }}
                  >
                    Show in PDF
                  </button>
                ) : null}
              </p>
            </div>
            <div className="ri-scores font-mono">
              <Score name={fused} value={r.score} max={scoreMax} bar={keys.length === 0} />
              {keys.map((key) => (
                <Score key={key} name={scaleName(key)} value={r.component_scores[key]} max={maxOf[key]} bar missed={MISSED[key] ?? "no match"} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Up takes the kept tint and down the removed tint, the pair the diff views use. */
const BADGE_TINT: Record<Badge["kind"], CSSProperties> = {
  up: { background: "var(--kept)", color: "var(--kept-text)" },
  down: { background: "var(--removed)", color: "var(--removed-text)" },
  stayed: { background: "var(--surface-hover)", color: "var(--text-secondary)" },
}

/** What an absent component score means, by the search that missed the hit. */
const MISSED: Record<string, string> = { bm25: "no keyword match", dense: "no meaning match" }

/**
 * One score with its scale named, `Dense 0.254`, and optionally a bar: it grows
 * from a 1px hairline baseline, no filled track (contract §11). Absent means
 * the search did not find the hit, which is different from scoring zero, so
 * `missed` says so. Three grid items per line (name, value, bar), placed in the
 * row's score subgrid; `.ri-score` itself is `display: contents`.
 */
function Score({ name, value, max, bar, missed }: { name: string; value: number | undefined; max: number; bar: boolean; missed?: string }) {
  const nameEl = <span className="ri-score-name text-xs text-fg-muted">{name}</span>
  if (value === undefined) {
    return (
      <span className="ri-score">
        {nameEl}
        <span className="ri-score-miss text-xs whitespace-nowrap text-fg-muted">{missed ?? ""}</span>
      </span>
    )
  }
  const w = barWidth(value, max, BAR)
  return (
    <span className="ri-score">
      {nameEl}
      <span className="text-right text-xs text-fg tabular-nums">{fmtScore(value)}</span>
      {bar ? (
        <span aria-hidden className="flex items-center" data-bar={w}>
          <span className="block h-[12px] w-px shrink-0 bg-hairline" />
          <span className="block h-[6px] shrink-0" style={{ width: w, background: "var(--score-3)" }} />
        </span>
      ) : (
        <span aria-hidden />
      )}
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
          <div data-reading="" className="min-w-0 font-sans text-base break-words whitespace-pre-wrap text-fg">
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
