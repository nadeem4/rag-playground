import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { ChatOutput, ChunkSet, GraphNode, ParsedDoc, Query, Registry, RetrievalResult, SampleQuestion } from "@/api/types"
import { loadMeta, useArtifactPayload } from "@/api/useArtifact"
import { KeyHint } from "@/components/ApiKeyControl"
import { ChatInspector } from "@/components/inspectors/ChatInspector"
import { movement, reorderedOnly, rowsFromResult, rowsFromSearch, type HitRowData, type SearchOutput } from "@/components/inspectors/hits"
import { RetrievalView } from "@/components/inspectors/RetrievalResultInspector"
import { WhatItDid } from "@/components/pipeline/WhatItDid"
import { Button } from "@/components/ui/button"
import { DRAW_MS, drawSlope, type SlopeKind } from "@/lib/slope"
import { askNodes, infoFor, titleFor, upstreamOfStage, type PipelineGraph } from "@/state/graph"
import { errorHeadline } from "@/state/pipeline"

import { RERANKERS, RETRIEVAL_LABEL } from "./AskSettings"
import { Finding } from "./Finding"
import { useSlope } from "./useSlope"
import { useWide } from "./useWide"

import "./ask.css"

/**
 * The results of the Ask panel: the finding sentence (or a Chat answer when
 * there is one), the sub line, then either one list in search order or, with a
 * reranker, the search order against the reranked order side by side. A
 * failed Ask step shows its error here.
 */

/** A completed result that still matches the graph. */
export function fresh(results: Record<string, NodeState>, stale: Set<string>, node: GraphNode | undefined): string | undefined {
  const r = node ? results[node.id] : undefined
  return r && (r.status === "done" || r.status === "cached") && !stale.has(r.id) ? r.artifact_id : undefined
}

/** What the Ask steps produced, loaded. */
export interface AskOutputs {
  /** The query node's payload: with an LLM rewrite, `text` is the rewrite and `original` the question. */
  query?: Query
  retrieve?: RetrievalResult
  retrieveId?: string
  rerank?: RetrievalResult
  rerankId?: string
  /** The use case's payload: a Search output or a Chat output. */
  output?: unknown
  chunkSet?: ChunkSet
  doc?: ParsedDoc
  failed?: { node: GraphNode; error: string }
}

const asResult = (d: unknown) => (d && Array.isArray((d as RetrievalResult).hits) ? (d as RetrievalResult) : undefined)
const isSearch = (d: unknown): d is SearchOutput => (d as SearchOutput | undefined)?.kind === "search"
const isChat = (d: unknown): d is ChatOutput => (d as ChatOutput | undefined)?.kind === "chat" && Boolean((d as ChatOutput).payload)

export function useAskOutputs(graph: PipelineGraph, results: Record<string, NodeState>, stale: Set<string>): AskOutputs {
  const { query, retrieve, rerank, useCase } = askNodes(graph)
  const retrieveId = fresh(results, stale, retrieve)
  const rerankId = fresh(results, stale, rerank)
  // The chunk set and the parsed document behind the hits: chunk hues and Show in PDF.
  const chunkNode = retrieve && retrieveId ? upstreamOfStage(graph, retrieve.id, "chunk") : undefined
  const docNode = retrieve && retrieveId ? upstreamOfStage(graph, retrieve.id, ["clean", "parse"]) : undefined
  const q = useArtifactPayload(fresh(results, stale, query))
  const r = useArtifactPayload(retrieveId)
  const rr = useArtifactPayload(rerankId)
  const out = useArtifactPayload(fresh(results, stale, useCase))
  const chunks = useArtifactPayload(fresh(results, stale, chunkNode))
  const doc = useArtifactPayload(fresh(results, stale, docNode))
  const failedNode = [query, retrieve, rerank, useCase].find((n) => n && results[n.id]?.status === "failed" && !stale.has(n.id))
  return {
    query: typeof (q.data as Query | undefined)?.text === "string" ? (q.data as Query) : undefined,
    retrieve: asResult(r.data),
    retrieveId,
    rerank: asResult(rr.data),
    rerankId,
    output: out.data,
    chunkSet: chunks.data as ChunkSet | undefined,
    doc: doc.data as ParsedDoc | undefined,
    failed: failedNode ? { node: failedNode, error: results[failedNode.id].error ?? "" } : undefined,
  }
}

/**
 * The list a reader ends with: the reranked order when a reranker ran, else
 * the Search output, else the retrieval result. Null until it has loaded.
 */
export function finalRows(o: AskOutputs, reranked: boolean): HitRowData[] | null {
  if (reranked) return o.rerank ? rowsFromResult(o.rerank) : null
  if (isSearch(o.output)) return rowsFromSearch(o.output)
  return o.retrieve ? rowsFromResult(o.retrieve) : null
}

/**
 * What retrieval actually searched for, once an Ask has run with a rewrite:
 * PRF's expanded keyword query, the borrowed terms in the data face, or the
 * model's rewrite with the question as asked under it. Nothing without one.
 */
export function SearchedFor({ outputs: o }: { outputs: AskOutputs }) {
  const original = o.query?.original?.trim()
  if (o.query && original) {
    return (
      <div className="flex flex-col gap-0.5 text-xs text-fg-muted">
        <p data-testid="searched-for">
          {"Searched for: "}
          <span className="text-fg">{o.query.text}</span>
        </p>
        <p data-testid="asked-as">{`Asked: ${original}`}</p>
      </div>
    )
  }
  const expanded = o.retrieve?.expanded_query
  const terms = o.retrieve?.expansion_terms ?? []
  if (!expanded || !terms.length) return null
  const added = terms.join(" ")
  const asked = expanded.endsWith(added) ? expanded.slice(0, expanded.length - added.length).trimEnd() : expanded
  return (
    <p data-testid="searched-for" className="text-xs text-fg-muted">
      {"Searched for: "}
      <span className="text-fg">{asked} </span>
      <span className="font-mono text-fg">{added}</span>
    </p>
  )
}

export const rerankLabel = (transform: string) => RERANKERS.find((r) => r.name === transform)?.label ?? transform

/** The retriever's plain name for the sub line: `Hybrid`, `Dense`, `BM25`. */
const retrieverName = (transform: string) => (RETRIEVAL_LABEL[transform] ?? transform).replace(/\s*\(.*\)$/, "")

/**
 * A run's note (`meta.note`), or null when it has none; undefined while it
 * loads. The meta is cached for the session, so What it did reads the same fetch.
 */
function useRunNote(id: string | undefined): string | null | undefined {
  const [state, setState] = useState<{ id?: string; note: string | null }>({ note: null })
  useEffect(() => {
    if (!id) return
    let live = true
    loadMeta(id).then(
      (m) => live && setState({ id, note: typeof m?.meta?.note === "string" && m.meta.note.trim() ? m.meta.note.trim() : null }),
      () => live && setState({ id, note: null }),
    )
    return () => {
      live = false
    }
  }, [id])
  return id && state.id === id ? state.note : undefined
}

const Heading = ({ children }: { children: ReactNode }) => <h3 className="text-sm font-semibold">{children}</h3>

export interface AskResultsProps {
  graph: PipelineGraph
  registry: Registry
  outputs: AskOutputs
  /** The rerank result whose comparison the reader hid, or null. Held by Build, so a card and Back to Ask keep it. */
  comparisonHidden: string | null
  onComparison: (hidden: string | null) => void
  /** True when an Ask step's last result no longer matches the settings: the old results are gone, so say why. */
  stale?: boolean
  /** The sample's question set, for the finding sentence; empty for an upload. */
  questions?: readonly SampleQuestion[]
}

export const STALE_LINE = "The settings changed since the last Ask. Press Ask to see the new results."

/** The slope's draw: 360 ms on `--ease-in` (spec section 6). */
export function drawTiming(): { duration: number; easing: string } {
  const ease = getComputedStyle(document.documentElement).getPropertyValue("--ease-in").trim()
  return { duration: DRAW_MS, easing: ease || "cubic-bezier(0.2, 0, 0, 1)" }
}

/*
 * What the two motions have already shown, by artifact id. Module level, not
 * component state: Back to Ask remounts the panel, and a cached result comes
 * back under the id it had (Cross-encoder, MMR, Cross-encoder again), and
 * neither may replay a motion the reader has seen.
 */
const listsShown = new Set<string>()
const slopesDrawn = new Set<string>()

/** Forget both, for tests. */
export function resetMotionMemory(): void {
  listsShown.clear()
  slopesDrawn.clear()
}

export function AskResults({ graph, registry, outputs: o, comparisonHidden, onComparison, stale = false, questions = [] }: AskResultsProps) {
  const { query, retrieve, rerank, useCase } = askNodes(graph)
  const chat = useCase?.transform === "chat" && isChat(o.output) ? o.output.payload : undefined
  // The reranker's run note is the sub line; its meta is fetched once and What it did reads the same cache.
  const note = useRunNote(rerank && o.rerank && o.retrieve ? o.rerankId : undefined)

  // Motion 3: a list fades in the first time it appears for its artifact id,
  // never again when Hide and Show comparison or Back to Ask remount it.
  const shown: string[] = []
  const enter = (id: string | undefined) => {
    if (id) shown.push(id)
    return id !== undefined && !listsShown.has(id)
  }
  useEffect(() => {
    for (const id of shown) listsShown.add(id)
  })

  let lists: ReactNode = null
  let kept: HitRowData[] | null = null
  let sub: string | null = null
  if (rerank && o.rerank && o.retrieve) {
    kept = rowsFromResult(o.rerank)
    // While the note loads its line is held empty, so it does not push the lists down when it lands.
    sub = note === undefined ? "" : note
    // Hidden for one rerank result only: a new result (a new run, another reranker) opens it again.
    const open = !o.rerankId || comparisonHidden !== o.rerankId
    lists = (
      <Comparison
        node={rerank}
        registry={registry}
        outputs={o}
        open={open}
        onToggle={() => onComparison(open ? (o.rerankId ?? null) : null)}
        enterSearch={enter(o.retrieveId)}
        enterReranked={enter(o.rerankId)}
        whatItDid={note === null}
      />
    )
  } else if (!rerank) {
    // With a reranker whose result is loading, failed or stale, no list: the order shown would not be the reranked one.
    const search = !rerank && isSearch(o.output) ? o.output : undefined
    // A Search use case trims the hits (six candidates, five shown): wait for its
    // output rather than show the retrieval rows and then swap them. Only a failed
    // use case falls back to the retrieval rows, under its error.
    const waiting = useCase?.transform === "search" && !search && o.failed?.node.id !== useCase.id
    const rows = waiting ? null : search ? rowsFromSearch(search) : o.retrieve ? rowsFromResult(o.retrieve) : null
    const total = search ? search.payload.total_candidates : o.retrieve?.total_candidates
    if (rows) {
      kept = rows
      const n = typeof total === "number" ? total : rows.length
      sub = `${retrieverName(retrieve?.transform ?? "")} search returned ${n} candidates. These are the top ${rows.length}, in search order.`
      lists = (
        <RetrievalView
          key={o.retrieveId}
          enter={enter(o.retrieveId)}
          rows={rows}
          chunkSet={o.chunkSet}
          doc={o.doc}
          showDetail={false}
          flat
          facts={null}
        />
      )
    }
  }
  if (!o.failed && !chat && !lists && !stale) return null
  return (
    <section aria-label="Results" className="flex flex-col gap-3 border-t border-hairline pt-3">
      {stale ? (
        <p data-testid="stale-results" className="text-xs text-fg-muted">
          {STALE_LINE}
        </p>
      ) : null}
      {o.failed ? <Failed node={o.failed.node} error={o.failed.error} /> : null}
      {chat ? <ChatInspector payload={chat} chunkSet={o.chunkSet} /> : null}
      {kept ? <Finding question={String(query?.config.text ?? "")} rows={kept} questions={questions} chat={Boolean(chat) || useCase?.transform === "chat"} /> : null}
      {sub !== null ? (
        <p data-testid="sub-line" className="m-0 min-h-[1lh] text-xs text-fg-muted">
          {sub}
        </p>
      ) : null}
      {lists}
    </section>
  )
}

function Failed({ node, error }: { node: GraphNode; error: string }) {
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-panel border border-hairline p-3">
      <p className="text-sm font-medium text-danger">{titleFor(node)} failed</p>
      <p className="max-w-[82ch] font-mono text-xs break-words text-fg-muted">{errorHeadline(error)}</p>
      {needsKey(node.transform, error) ? <KeyHint /> : null}
    </div>
  )
}

/** How long the linked highlight holds after the pointer or the focus leaves a slip, in ms. */
const LIT_GRACE_MS = 80

/** The piece of the slip an event came from, by its swatch's `data-id`; null outside a slip. */
function pieceAt(target: EventTarget | null): string | null {
  const slip = target instanceof Element ? target.closest("[data-slip]") : null
  return slip?.querySelector<HTMLElement>("[data-id]")?.dataset.id ?? null
}

/** A kept piece's movement as a slope kind: unmoved is `same`. */
function slopeKind(row: HitRowData): SlopeKind {
  const m = movement(row)
  return m.kind === "none" ? "same" : m.kind
}

/**
 * The search order against the reranked order. Open by default; the reader
 * can hide it for one rerank result, and Build keeps that choice. Hidden, the
 * right list's own title sits beside Show comparison.
 */
function Comparison({
  node,
  registry,
  outputs: o,
  open,
  onToggle,
  enterSearch,
  enterReranked,
  whatItDid,
}: {
  node: GraphNode
  registry: Registry
  outputs: AskOutputs
  open: boolean
  onToggle: () => void
  enterSearch: boolean
  enterReranked: boolean
  /** True when the reranker left no run note: What it did says the outcome under the list instead. */
  whatItDid: boolean
}) {
  const before = rowsFromResult(o.retrieve!)
  const after = rowsFromResult(o.rerank!)
  const kept = new Set(after.map((r) => r.chunk_id))
  // The candidates the reranker dropped, each with its search place, follow the kept ones as Not kept slips.
  const dropped = before.filter((r) => !kept.has(r.chunk_id)).map((r) => ({ ...r, prior_rank: r.rank }))
  // At 1280 px and up the lists sit side by side with the slope between them;
  // below, they stack, no line is drawn, and the search order folds away.
  const wide = useWide()
  const sideBySide = open && wide
  // The slope: one line per kept piece, coloured by how it moved.
  const gridRef = useRef<HTMLDivElement>(null)
  const moves = new Map<string, SlopeKind>(after.map((r) => [r.chunk_id, slopeKind(r)]))
  const lines = useSlope(gridRef, sideBySide, o.rerankId, moves)
  // Motion 4: once per rerank result, the lines draw from left to right, once
  // they are measured at the final places. Never on a rerender, a collapse, an
  // expand or a remount.
  const svgRef = useRef<SVGSVGElement>(null)
  useLayoutEffect(() => {
    const id = o.rerankId
    if (!svgRef.current || !id || !lines.length || slopesDrawn.has(id)) return
    slopesDrawn.add(id)
    drawSlope(svgRef.current, drawTiming())
  }, [lines, o.rerankId])
  // The linked highlight: the piece under the pointer or the focus, lit in both
  // lists and on its line. It clears after a short grace, so crossing the gap
  // between two slips does not flash everything off and on.
  const [lit, setLit] = useState<string | null>(null)
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settle = () => {
    if (grace.current) clearTimeout(grace.current)
    grace.current = null
  }
  const lightNow = (id: string) => {
    settle()
    setLit(id)
  }
  const clearSoon = () => {
    if (grace.current) return
    grace.current = setTimeout(() => {
      grace.current = null
      setLit(null)
    }, LIT_GRACE_MS)
  }
  const hover = (target: EventTarget | null) => {
    const id = pieceAt(target)
    if (id) lightNow(id)
    else clearSoon()
  }
  useEffect(() => settle, [])
  // Stacked, the twin is a screen away and hover shows nothing: a tap lights a
  // slip, brings its twin into view, and a second tap clears it.
  const tap = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest("button, a")) return
    const id = pieceAt(target)
    if (!id) return
    const next = lit === id ? null : id
    setLit(next)
    if (!next) return
    const slip = target.closest("[data-slip]")
    const twin = [...(gridRef.current?.querySelectorAll("[data-slip]") ?? [])].find((el) => el !== slip && el.querySelector<HTMLElement>("[data-id]")?.dataset.id === id)
    twin?.scrollIntoView?.({ block: "nearest" })
  }
  const pressable = open && !wide
  const [searchShown, setSearchShown] = useState(false)
  const litLine = lit !== null && lines.some((l) => l.id === lit)
  const toggle = (
    <Button variant="outline" size="sm" aria-expanded={open} onClick={onToggle}>
      {open ? "Hide comparison" : "Show comparison"}
    </Button>
  )
  const title = <Heading>{`After rerank, ${rerankLabel(node.transform)}, ${after.length} kept`}</Heading>
  // MMR and the LLM reranker reorder without rescoring: say why the scores are not in order.
  const note = reorderedOnly(after) ? (
    <p className="basis-full text-xs text-fg-muted">{`Ordered by ${rerankLabel(node.transform)}; the scores are the search's.`}</p>
  ) : null
  const reranked = (
    <div data-column="reranked" className="flex min-w-0 flex-col gap-2">
      <RetrievalView
        key={o.rerankId}
        enter={enterReranked}
        rows={[...after, ...dropped]}
        chunkSet={o.chunkSet}
        doc={o.doc}
        showDetail={false}
        side="reranked"
        flat
        reranker={node.transform}
        kept={kept}
        keepLimit={after.length}
        compact={open}
        lit={open ? lit : null}
        pressable={pressable}
        facts={
          open ? (
            title
          ) : (
            <>
              <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
                {title}
                {toggle}
              </div>
              {note}
            </>
          )
        }
      />
      {/* The reranker's run note is the sub line above the results; without one, What it did says the outcome here. */}
      {o.rerankId && whatItDid ? <WhatItDid stage="rerank" type={infoFor(registry, node)?.output} artifactId={o.rerankId} preferNote /> : null}
    </div>
  )
  if (!open) return reranked
  const search = (
    <div data-column="search" className="min-w-0">
      <RetrievalView
        key={o.retrieveId}
        enter={enterSearch}
        rows={before}
        chunkSet={o.chunkSet}
        doc={o.doc}
        showDetail={false}
        side="search"
        flat
        compact
        lit={lit}
        pressable={pressable}
        facts={<Heading>{`Search order, ${before.length} candidates`}</Heading>}
      />
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>Search order against the reranked order</Heading>
        {toggle}
      </div>
      {/* Above both lists, so the two start level and a stayed piece's line runs flat. */}
      {note}
      {wide ? (
        <div
          ref={gridRef}
          data-slope-grid=""
          className="relative grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] xl:items-start"
          onMouseOver={(e) => hover(e.target)}
          onMouseLeave={clearSoon}
          onFocus={(e) => hover(e.target)}
          onBlur={clearSoon}
        >
          <svg ref={svgRef} className="slope-lines" aria-hidden data-active={litLine ? "" : undefined}>
            {lines.map((l) => (
              <path key={l.id} data-id={l.id} data-kind={l.kind} d={l.d} className={l.id === lit ? "lit" : undefined} />
            ))}
          </svg>
          {search}
          {/* The gutter the lines cross. */}
          <div data-gutter="" aria-hidden className="hidden xl:block" />
          {reranked}
        </div>
      ) : (
        <div
          ref={gridRef}
          data-slope-grid=""
          className="flex flex-col gap-3"
          onClick={(e) => tap(e.target)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches("[data-slip]")) tap(e.target)
          }}
        >
          {reranked}
          <div>
            <Button variant="outline" size="sm" aria-expanded={searchShown} onClick={() => setSearchShown(!searchShown)}>
              {searchShown ? "Hide search order" : "Show search order"}
            </Button>
          </div>
          {searchShown ? search : null}
        </div>
      )}
    </div>
  )
}
