import type { ReactNode } from "react"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { ChatOutput, ChunkSet, GraphNode, ParsedDoc, Registry, RetrievalResult } from "@/api/types"
import { useArtifactPayload } from "@/api/useArtifact"
import { KeyHint } from "@/components/ApiKeyControl"
import { ChatInspector } from "@/components/inspectors/ChatInspector"
import { rowsFromResult, rowsFromSearch, type HitRowData, type SearchOutput } from "@/components/inspectors/hits"
import { RetrievalView } from "@/components/inspectors/RetrievalResultInspector"
import { WhatItDid } from "@/components/pipeline/WhatItDid"
import { Button } from "@/components/ui/button"
import { askNodes, infoFor, titleFor, upstreamOfStage, type PipelineGraph } from "@/state/graph"
import { errorHeadline } from "@/state/pipeline"

import { RERANKERS } from "./AskSettings"

/**
 * The results of the Ask panel: a Chat answer when there is one, then either
 * one list in search order or, with a reranker, the search order against the
 * reranked order side by side. A failed Ask step shows its error here.
 */

/** A completed result that still matches the graph. */
export function fresh(results: Record<string, NodeState>, stale: Set<string>, node: GraphNode | undefined): string | undefined {
  const r = node ? results[node.id] : undefined
  return r && (r.status === "done" || r.status === "cached") && !stale.has(r.id) ? r.artifact_id : undefined
}

/** What the Ask steps produced, loaded. */
export interface AskOutputs {
  retrieve?: RetrievalResult
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

const Heading = ({ children }: { children: ReactNode }) => <h3 className="text-sm font-semibold">{children}</h3>

export interface AskResultsProps {
  graph: PipelineGraph
  registry: Registry
  outputs: AskOutputs
  /** The rerank result whose comparison the reader hid, or null. Held by Build, so a card and Back to Ask keep it. */
  comparisonHidden: string | null
  onComparison: (hidden: string | null) => void
}

export function AskResults({ graph, registry, outputs: o, comparisonHidden, onComparison }: AskResultsProps) {
  const { rerank, useCase } = askNodes(graph)
  const chat = useCase?.transform === "chat" && isChat(o.output) ? o.output.payload : undefined
  let lists: ReactNode = null
  if (rerank && o.rerank && o.retrieve) {
    // Hidden for one rerank result only: a new result (a new run, another reranker) opens it again.
    const open = !o.rerankId || comparisonHidden !== o.rerankId
    lists = (
      <Comparison node={rerank} registry={registry} outputs={o} open={open} onToggle={() => onComparison(open ? (o.rerankId ?? null) : null)} />
    )
  } else if (!rerank) {
    // With a reranker whose result is loading, failed or stale, no list: the order shown would not be the reranked one.
    const search = !rerank && isSearch(o.output) ? o.output : undefined
    const rows = search ? rowsFromSearch(search) : o.retrieve ? rowsFromResult(o.retrieve) : null
    const total = search ? search.payload.total_candidates : o.retrieve?.total_candidates
    if (rows) {
      lists = (
        <RetrievalView
          rows={rows}
          chunkSet={o.chunkSet}
          doc={o.doc}
          showDetail={false}
          facts={<Heading>{`Top ${rows.length} of ${typeof total === "number" ? total : rows.length} candidates, in search order`}</Heading>}
        />
      )
    }
  }
  if (!o.failed && !chat && !lists) return null
  return (
    <section aria-label="Results" className="flex flex-col gap-3 border-t border-hairline pt-3">
      {o.failed ? <Failed node={o.failed.node} error={o.failed.error} /> : null}
      {chat ? <ChatInspector payload={chat} chunkSet={o.chunkSet} /> : null}
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
}: {
  node: GraphNode
  registry: Registry
  outputs: AskOutputs
  open: boolean
  onToggle: () => void
}) {
  const before = rowsFromResult(o.retrieve!)
  const after = rowsFromResult(o.rerank!)
  const kept = new Set(after.map((r) => r.chunk_id))
  const toggle = (
    <Button variant="outline" size="sm" aria-expanded={open} onClick={onToggle}>
      {open ? "Hide comparison" : "Show comparison"}
    </Button>
  )
  const title = <Heading>{`After rerank, ${rerankLabel(node.transform)}, ${after.length} kept`}</Heading>
  const reranked = (
    <div data-column="reranked" className="flex min-w-0 flex-col gap-2">
      <RetrievalView
        rows={after}
        chunkSet={o.chunkSet}
        doc={o.doc}
        showDetail={false}
        badges
        facts={
          open ? (
            title
          ) : (
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
              {title}
              {toggle}
            </div>
          )
        }
      />
      {/* The reranker's run note states the movement count; it is said here and nowhere else. */}
      {o.rerankId ? <WhatItDid stage="rerank" type={infoFor(registry, node)?.output} artifactId={o.rerankId} preferNote /> : null}
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
            rows={before}
            chunkSet={o.chunkSet}
            doc={o.doc}
            showDetail={false}
            kept={kept}
            facts={<Heading>{`Search order, ${before.length} candidates`}</Heading>}
          />
        </div>
        {reranked}
      </div>
    </div>
  )
}
