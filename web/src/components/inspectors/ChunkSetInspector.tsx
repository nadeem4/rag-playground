import { Fragment, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react"

import type { Chunk, ChunkSet } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { cn } from "@/lib/utils"

import "./inspectors.css"
import { useSpineLayout } from "./spine"
import { assignLanes, chunkSlot, median, overlapPairs, p95, projectSpans, type Segment } from "./spans"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * The chunk-boundary view. `source_text` is drawn once as a calm reading
 * column; every segment of constant chunk coverage is one inline span. The
 * position spine on its left carries one band per chunk and a token-count bar
 * per chunk, both measured off the rendered text.
 */

export interface ChunkSetInspectorProps {
  chunkSet?: ChunkSet
  status?: InspectorStatus
  /** Index into `chunks` to select on mount (gallery and tests). */
  initialSelected?: number | null
  /** False drops the metadata panel, for side-by-side comparisons. */
  showDetail?: boolean
}

export function ChunkSetInspector({ chunkSet, status, initialSelected = null, showDetail = true }: ChunkSetInspectorProps) {
  const screen = statusScreen(status, "chunk set")
  if (screen) return <Frame>{<div className="bg-surface">{screen}</div>}</Frame>
  if (!chunkSet) {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No chunk set yet">Run the Chunk stage to cut this document into chunks.</EmptyState>
        </div>
      </Frame>
    )
  }
  return <ChunkSetView set={chunkSet} initialSelected={initialSelected} showDetail={showDetail} />
}

// ---------------------------------------------------------------- layout --

const LANE = 6 // px per spine lane: a 4px band plus a 2px surface gap
const BAR_MAX = 44 // px, the widest token bar
const LABEL_W = 28 // px reserved for the token-count label

function ChunkSetView({
  set,
  initialSelected,
  showDetail,
}: {
  set: ChunkSet
  initialSelected: number | null
  showDetail: boolean
}) {
  const { chunks, source_text: source } = set
  const [selected, setSelected] = useState<number | null>(initialSelected)
  const rootRef = useRef<HTMLDivElement>(null)

  const segments = useMemo(() => projectSpans(source, chunks), [source, chunks])
  const derived = useMemo(() => {
    const lanes = assignLanes(chunks)
    const laneCount = Math.max(1, ...lanes.map((l) => l + 1))
    // Segment index range per chunk, for measuring its band.
    const first = new Array<number>(chunks.length).fill(-1)
    const last = new Array<number>(chunks.length).fill(-1)
    segments.forEach((s, k) => {
      for (const i of s.chunks) {
        if (first[i] === -1) first[i] = k
        last[i] = k
      }
    })
    const tokens = chunks.map((c) => c.token_count)
    const uncovered = segments.filter((s) => s.chunks.length === 0).reduce((n, s) => n + s.end - s.start, 0)
    return {
      lanes,
      laneCount,
      first,
      last,
      maxTokens: Math.max(1, ...tokens),
      stats: {
        chunks: chunks.length,
        total: tokens.reduce((a, b) => a + b, 0),
        median: median(tokens),
        p95: p95(tokens),
        overlaps: overlapPairs(segments).length,
        uncovered,
      },
    }
  }, [chunks, segments])

  useSpineLayout(rootRef, [segments])

  // Hover: a data attribute on the root, written through the ref. No state,
  // no re-render; CSS undims the matching segments, bands and bars.
  const onPointerOver = (e: PointerEvent) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-chunks]")
    const root = rootRef.current
    if (!root) return
    if (hit?.dataset.chunks) root.dataset.hover = hit.dataset.chunks
    else delete root.dataset.hover
  }
  const onPointerLeave = () => {
    if (rootRef.current) delete rootRef.current.dataset.hover
  }

  // Clicking text selects a covering chunk; clicking an overlap again cycles
  // to the next chunk that covers it.
  const onTextClick = (e: React.MouseEvent) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]")
    const k = hit?.dataset.seg
    if (k === undefined) return
    const covering = segments[+k].chunks
    if (covering.length === 0) return
    const at = selected === null ? -1 : covering.indexOf(selected)
    setSelected(covering[(at + 1) % covering.length])
  }

  const hoverRules = useMemo(
    () =>
      chunks
        .map((_, i) => `[data-hover~="c${i}"] :is(.ci-seg,.ci-band,.ci-bar).c${i}:not([data-gap]){opacity:1}`)
        .join(""),
    [chunks],
  )

  const spineWidth = derived.laneCount * LANE + 4 + BAR_MAX + LABEL_W
  const barX = derived.laneCount * LANE + 4
  const empty = chunks.length === 0

  return (
    <Frame>
      <Summary stats={derived.stats} meta={set.chunker_meta} />
      <div
        ref={rootRef}
        data-chunk-inspector=""
        onPointerOver={onPointerOver}
        onPointerLeave={onPointerLeave}
        className={cn("grid min-h-0 gap-px bg-hairline", showDetail && "lg:grid-cols-[minmax(0,1fr)_320px]")}
      >
        <style>{hoverRules}</style>
        <div className="max-h-[560px] min-w-0 overflow-y-auto bg-surface">
          {empty ? (
            <EmptyState title="No chunks">
              {source.length === 0
                ? "The document has no text, so the chunker had nothing to cut."
                : `The chunker produced 0 chunks from ${fmt(source.length)} characters. All of the text below is uncovered.`}
            </EmptyState>
          ) : null}
          {source.length > 0 ? (
            <div
              className="grid gap-3 px-3 py-3"
              style={{ gridTemplateColumns: `${spineWidth}px minmax(0, 82ch)` }}
            >
              <Spine
                chunks={chunks}
                lanes={derived.lanes}
                first={derived.first}
                last={derived.last}
                maxTokens={derived.maxTokens}
                barX={barX}
                selected={selected}
                onSelect={setSelected}
              />
              <Reading segments={segments} source={source} selected={selected} onClick={onTextClick} />
            </div>
          ) : null}
        </div>
        {showDetail ? <Detail chunk={selected === null ? undefined : chunks[selected]} index={selected} /> : null}
      </div>
    </Frame>
  )
}

// --------------------------------------------------------------- summary --

function Stat({ label, value, id }: { label: string; value: ReactNode; id: string }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span data-testid={`summary-${id}`} className="font-mono text-sm text-fg tabular-nums">
        {value}
      </span>
      <span className="text-xs text-fg-muted">{label}</span>
    </span>
  )
}

function Summary({
  stats,
  meta,
}: {
  stats: { chunks: number; total: number; median: number | null; p95: number | null; overlaps: number; uncovered: number }
  meta: Record<string, unknown>
}) {
  const dash = (n: number | null) => (n === null ? "n/a" : fmt(n))
  const params = Object.entries(meta)
    .filter(([k]) => k !== "chunker")
    .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 bg-surface-elevated px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Stat id="chunks" label="chunks" value={fmt(stats.chunks)} />
        <Stat id="total" label="tokens" value={fmt(stats.total)} />
        <Stat id="median" label="median" value={dash(stats.median)} />
        <Stat id="p95" label="p95" value={dash(stats.p95)} />
        <Stat id="overlaps" label="overlaps" value={fmt(stats.overlaps)} />
        <Stat id="uncovered" label="chars uncovered" value={fmt(stats.uncovered)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {stats.chunks > 0 ? (
          <>
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <span aria-hidden className="ci-key-overlap block h-[12px] w-[20px]" />
              overlap
            </span>
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <span aria-hidden className="ci-seg font-mono" data-gap="blank">
                ↵
              </span>
              uncovered
            </span>
          </>
        ) : null}
        {params.length ? <span className="font-mono text-xs text-fg-muted">{params.join("  ")}</span> : null}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- spine --

function Spine({
  chunks,
  lanes,
  first,
  last,
  maxTokens,
  barX,
  selected,
  onSelect,
}: {
  chunks: Chunk[]
  lanes: number[]
  first: number[]
  last: number[]
  maxTokens: number
  barX: number
  selected: number | null
  onSelect: (i: number) => void
}) {
  return (
    <div data-spine="" aria-label="Position spine" className="relative">
      {/* Hairline baseline for the token bars: no filled track (contract §11). */}
      <span aria-hidden className="absolute top-0 bottom-0 w-px bg-hairline" style={{ left: barX - 1 }} />
      {chunks.map((c, i) => {
        if (first[i] === -1) return null // zero-length or out of range: nothing to measure against
        const slot = chunkSlot(i)
        const w = Math.max(1, Math.round((c.token_count / maxTokens) * BAR_MAX))
        return (
          <Fragment key={i}>
            <button
              type="button"
              data-band=""
              data-chunks={`c${i}`}
              data-first={first[i]}
              data-last={last[i]}
              aria-label={`Chunk ${i + 1}, ${c.token_count} tokens, characters ${c.start_char} to ${c.end_char}`}
              aria-pressed={selected === i}
              onClick={() => onSelect(i)}
              className={cn("ci-band absolute w-[4px] cursor-pointer p-0", `c${i}`, selected === i && "sel")}
              style={{ left: lanes[i] * LANE, background: `var(--chunk-${slot})` }}
            />
            <span
              data-bar=""
              data-chunks={`c${i}`}
              data-first={first[i]}
              data-last={last[i]}
              data-anchor="mid"
              className={cn("ci-bar absolute flex -translate-y-1/2 items-center gap-1", `c${i}`)}
              style={{ left: barX }}
            >
              <span aria-hidden className="block h-[6px]" style={{ width: w, background: `var(--chunk-${slot})` }} />
              <span className="font-mono text-2xs text-fg-muted tabular-nums">{c.token_count}</span>
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

// --------------------------------------------------------------- reading --

function segmentStyle(s: Segment): CSSProperties | undefined {
  if (s.chunks.length === 0) return undefined
  const a = chunkSlot(s.chunks[0])
  const style: Record<string, string> = { "--a": `var(--chunk-${a})`, "--a-text": `var(--chunk-${a}-text)` }
  if (s.chunks.length > 1) style["--b"] = `var(--chunk-${chunkSlot(s.chunks[1])})`
  return style as CSSProperties
}

/** Make an uncovered line break visible: a return glyph before each newline. */
function gapText(text: string): ReactNode {
  if (text.trim() !== "") return text
  return text.split("\n").map((part, k, all) => (
    <Fragment key={k}>
      {part}
      {k < all.length - 1 ? (
        <>
          <span aria-hidden className="ci-glyph">
            ↵
          </span>
          {"\n"}
        </>
      ) : null}
    </Fragment>
  ))
}

/**
 * Covered text, with every blank line that lies wholly inside the segment
 * given a zero-height, full-width filler. On a blank line the span has no
 * glyphs, so its fragment would be zero wide and the chunk would break into
 * two stripes; the filler widens that fragment to the column, and the span's
 * own padded background fills it. It holds no characters, so the DOM text is
 * still exactly the source.
 */
function coveredText(text: string): ReactNode {
  if (!text.includes("\n\n")) return text
  return text.split("\n").map((line, k, all) => (
    <Fragment key={k}>
      {k > 0 ? "\n" : null}
      {line === "" && k > 0 && k < all.length - 1 ? <span aria-hidden data-blank-fill="" className="ci-fill" /> : line}
    </Fragment>
  ))
}

function Reading({
  segments,
  source,
  selected,
  onClick,
}: {
  segments: Segment[]
  source: string
  selected: number | null
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <div
      data-reading=""
      onClick={onClick}
      className="min-w-0 font-mono text-base leading-[1.65] break-words whitespace-pre-wrap text-fg"
    >
      {segments.map((s, k) => {
        const text = source.slice(s.start, s.end)
        const gap = s.chunks.length === 0
        return (
          <span
            key={k}
            data-seg={k}
            data-target={k}
            data-slot={gap ? undefined : chunkSlot(s.chunks[0])}
            data-chunks={gap ? undefined : s.chunks.map((i) => `c${i}`).join(" ")}
            data-overlap={s.chunks.length > 1 ? "" : undefined}
            data-gap={gap ? (text.trim() === "" ? "blank" : "") : undefined}
            className={cn(
              "ci-seg",
              s.chunks.map((i) => `c${i}`),
              selected !== null && s.chunks.includes(selected) && "sel",
              !gap && "cursor-pointer",
            )}
            style={segmentStyle(s)}
          >
            {gap ? gapText(text) : coveredText(text)}
          </span>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- detail --

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="meta">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-words text-fg">{children}</dd>
    </>
  )
}

function Detail({ chunk, index }: { chunk?: Chunk; index: number | null }) {
  if (!chunk || index === null) {
    return (
      <aside data-testid="chunk-detail" className="bg-surface">
        <EmptyState title="No chunk selected">Select a chunk in the text or on the spine to see its metadata.</EmptyState>
      </aside>
    )
  }
  const slot = chunkSlot(index)
  const differs = chunk.embed_text !== null && chunk.embed_text !== chunk.text
  const pages = chunk.page_span
    ? chunk.page_span[0] === chunk.page_span[1]
      ? `${chunk.page_span[0]}`
      : `${chunk.page_span[0]}-${chunk.page_span[1]}`
    : "none"
  return (
    <aside data-testid="chunk-detail" className="flex max-h-[560px] min-w-0 flex-col gap-3 overflow-y-auto bg-surface p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className="block h-[12px] w-[4px]" style={{ background: `var(--chunk-${slot})` }} />
        <h3 className="text-sm font-semibold">Chunk {index + 1}</h3>
      </div>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">
        <Field label="id">{chunk.id}</Field>
        <Field label="ordinal">{chunk.ordinal}</Field>
        <Field label="kind">{chunk.kind}</Field>
        <Field label="tokens">{fmt(chunk.token_count)}</Field>
        <Field label="chars">
          {chunk.start_char}-{chunk.end_char}
        </Field>
        <Field label="heading">{chunk.heading_path.length ? chunk.heading_path.join(" / ") : "none"}</Field>
        <Field label="pages">{pages}</Field>
        <Field label="elements">{chunk.source_element_ids.length}</Field>
      </dl>
      <TextBlock label="text">{chunk.text}</TextBlock>
      {differs ? <TextBlock label="embed_text">{chunk.embed_text}</TextBlock> : null}
    </aside>
  )
}

function TextBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="meta">{label}</span>
      <p className="rounded-control border border-hairline bg-surface-elevated p-2 font-mono text-xs whitespace-pre-wrap text-fg">
        {children}
      </p>
    </div>
  )
}
