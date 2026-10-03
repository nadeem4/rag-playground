import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { ChatOutput, ChunkSet, GraphNode, ParsedDoc, Registry, RetrievalResult, SampleQuestion } from "@/api/types"
import { loadMeta, useArtifactPayload } from "@/api/useArtifact"
import { KeyHint } from "@/components/ApiKeyControl"
import { ChatInspector } from "@/components/inspectors/ChatInspector"
import { reorderedOnly, rowsFromResult, rowsFromSearch, type HitRowData, type SearchOutput } from "@/components/inspectors/hits"
import { RetrievalView } from "@/components/inspectors/RetrievalResultInspector"
import { WhatItDid } from "@/components/pipeline/WhatItDid"
import { Button } from "@/components/ui/button"
import { measure, play, type Rect } from "@/lib/flip"
import { askNodes, infoFor, titleFor, upstreamOfStage, type PipelineGraph } from "@/state/graph"
import { errorHeadline } from "@/state/pipeline"

import { RERANKERS, RETRIEVAL_LABEL } from "./AskSettings"
import { Finding } from "./Finding"

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
  const r = useArtifactPayload(retrieveId)
  const rr = useArtifactPayload(rerankId)
  const out = useArtifactPayload(fresh(results, stale, useCase))
  const chunks = useArtifactPayload(fresh(results, stale, chunkNode))
  const doc = useArtifactPayload(fresh(results, stale, docNode))
  const failedNode = [query, retrieve, rerank, useCase].find((n) => n && results[n.id]?.status === "failed" && !stale.has(n.id))
  return {
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

/**
 * Where each reranked hit stood before the rerank, as a place in the reranked
 * list itself: the hit that was #3 starts where row 3 is now. A hit from below
 * the kept rows starts just under the last one. The rows mount fresh with the
 * result (the old list is gone while Ask runs), so the slots of the new list
 * are the only "before" there is.
 */
export function priorPlaces(now: ReadonlyMap<string, Rect>, rows: readonly HitRowData[]): Map<string, Rect> {
  const slots = rows.map((r) => now.get(r.chunk_id))
  const last = slots[slots.length - 1]
  const out = new Map<string, Rect>()
  for (const r of rows) {
    const p = r.prior_rank
    if (p === null || p < 1) continue
    const slot = p <= slots.length ? slots[p - 1] : last && { left: last.left, top: last.top + (last.height ?? 0) }
    if (slot) out.set(r.chunk_id, slot)
  }
  return out
}

/**
 * A CSS time in milliseconds. The built stylesheet is minified, so `320ms`
 * reads back as `.32s`: the unit must be read, not assumed.
 */
export function durationMs(raw: string, fallback: number): number {
  const v = raw.trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : fallback
}

/** Motion 4's timing from the tokens: `--dur-slow` on `--ease-in`. */
export function slideTiming(): { duration: number; easing: string } {
  const css = getComputedStyle(document.documentElement)
  return {
    duration: durationMs(css.getPropertyValue("--dur-slow"), 320),
    easing: css.getPropertyValue("--ease-in").trim() || "cubic-bezier(0.2, 0, 0, 1)",
  }
}

/*
 * What the two motions have already shown, by artifact id. Module level, not
 * component state: Back to Ask remounts the panel, and a cached result comes
 * back under the id it had (Cross-encoder, MMR, Cross-encoder again), and
 * neither may replay a motion the reader has seen.
 */
const listsShown = new Set<string>()
const reranksPlayed = new Set<string>()

/** Forget both, for tests. */
export function resetMotionMemory(): void {
  listsShown.clear()
  reranksPlayed.clear()
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

  // Motion 4: once per rerank result, the reranked hits slide from the place
  // of their prior rank. Never on a rerender, a collapse, an expand or a remount.
  const flipRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = flipRef.current
    const id = o.rerankId
    if (!el || !id || !o.rerank || reranksPlayed.has(id)) return
    reranksPlayed.add(id)
    play(el, priorPlaces(measure(el, "[data-flip-key]"), rowsFromResult(o.rerank)), slideTiming())
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
        flipRef={flipRef}
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
  flipRef,
  whatItDid,
}: {
  node: GraphNode
  registry: Registry
  outputs: AskOutputs
  open: boolean
  onToggle: () => void
  enterSearch: boolean
  enterReranked: boolean
  /** The reranked column, where motion 4 plays. */
  flipRef: RefObject<HTMLDivElement | null>
  /** True when the reranker left no run note: What it did says the outcome under the list instead. */
  whatItDid: boolean
}) {
  const before = rowsFromResult(o.retrieve!)
  const after = rowsFromResult(o.rerank!)
  const kept = new Set(after.map((r) => r.chunk_id))
  // The candidates the reranker dropped, each with its search place, follow the kept ones as Not kept slips.
  const dropped = before.filter((r) => !kept.has(r.chunk_id)).map((r) => ({ ...r, prior_rank: r.rank }))
  const toggle = (
    <Button variant="outline" size="sm" aria-expanded={open} onClick={onToggle}>
      {open ? "Hide comparison" : "Show comparison"}
    </Button>
  )
  const title = <Heading>{`After rerank, ${rerankLabel(node.transform)}, ${after.length} kept`}</Heading>
  const reranked = (
    <div ref={flipRef} data-column="reranked" className="flex min-w-0 flex-col gap-2">
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
        facts={
          <>
            {open ? (
              title
            ) : (
              <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
                {title}
                {toggle}
              </div>
            )}
            {/* MMR and the LLM reranker reorder without rescoring: say why the scores are not in order. */}
            {reorderedOnly(after) ? (
              <p className="basis-full text-xs text-fg-muted">{`Ordered by ${rerankLabel(node.transform)}; the scores are the search's.`}</p>
            ) : null}
          </>
        }
      />
      {/* The reranker's run note is the sub line above the results; without one, What it did says the outcome here. */}
      {o.rerankId && whatItDid ? <WhatItDid stage="rerank" type={infoFor(registry, node)?.output} artifactId={o.rerankId} preferNote /> : null}
    </div>
  )
  if (!open) return reranked
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>Search order against the reranked order</Heading>
        {toggle}
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
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
            facts={<Heading>{`Search order, ${before.length} candidates`}</Heading>}
          />
        </div>
        {reranked}
      </div>
    </div>
  )
}
