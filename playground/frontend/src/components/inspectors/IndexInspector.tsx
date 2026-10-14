import type { ReactNode } from "react"

import { EmptyState } from "@/components/EmptyState"

import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * An index is a directory holding a database; the API serves its capability
 * descriptor (spec §5), not the data. Shown as a tidy metadata table. Keys the
 * table does not know are listed after the known ones, so a new descriptor
 * field shows up rather than vanishing.
 */

export interface IndexDescriptor {
  backends?: string[]
  native_dim?: number
  dim?: number
  metric?: string
  embedder?: string
  embedding_model?: string
  embedding_revision?: string
  vector_kind?: string
  doc_count?: number
  /** Plan I-3: chunks embedded by this build, and chunks served from the embedding cache. */
  embeddings_computed?: number
  embeddings_cached?: number
  [key: string]: unknown
}

const KNOWN = new Set([
  "backends", "native_dim", "dim", "metric", "embedder", "embedding_model", "embedding_revision",
  "vector_kind", "doc_count", "embeddings_computed", "embeddings_cached",
])

const num = (v: unknown) => (typeof v === "number" ? fmt(v) : undefined)

/** `computed 6, cached 0`, or null when the descriptor predates those keys. */
export function embeddingCounts(d: IndexDescriptor | undefined): string | null {
  if (!d || (typeof d.embeddings_computed !== "number" && typeof d.embeddings_cached !== "number")) return null
  return `${num(d.embeddings_computed) ?? "?"} embedded, ${num(d.embeddings_cached) ?? "?"} from cache`
}

export function IndexInspector({ descriptor, status }: { descriptor?: IndexDescriptor; status?: InspectorStatus }) {
  const screen = statusScreen(status, "index")
  if (screen) return <Frame><div className="bg-surface">{screen}</div></Frame>
  if (!descriptor || typeof descriptor !== "object") {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No index yet">Run Index to embed the chunks and build the index.</EmptyState>
        </div>
      </Frame>
    )
  }
  const d = descriptor
  const truncated = typeof d.dim === "number" && typeof d.native_dim === "number" && d.dim < d.native_dim
  const model = d.embedding_model
  const rows: [string, ReactNode][] = [
    ["embedder", d.embedder ?? model ?? "not reported"],
    ...(d.embedder && model && model !== d.embedder ? ([["model", model]] as [string, ReactNode][]) : []),
    ["revision", d.embedding_revision ?? "not reported"],
    ["native dim", num(d.native_dim) ?? "not reported"],
    ["dim", d.dim === undefined ? "not reported" : truncated ? `${fmt(d.dim)}, truncated from ${fmt(d.native_dim!)}` : fmt(d.dim)],
    ["metric", d.metric ?? "not reported"],
    ["backends", Array.isArray(d.backends) && d.backends.length ? d.backends.join(", ") : "none"],
    ["vector kind", d.vector_kind ?? "not reported"],
    ["doc count", num(d.doc_count) ?? "not reported"],
    ["embedded", num(d.embeddings_computed) ?? "not reported"],
    ["from cache", num(d.embeddings_cached) ?? "not reported"],
    ...Object.entries(d)
      .filter(([k]) => !KNOWN.has(k))
      .map(([k, v]): [string, ReactNode] => [k.replace(/_/g, " "), typeof v === "string" ? v : JSON.stringify(v)]),
  ]
  return (
    <Frame>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface-elevated px-3 py-2">
        <span className="flex items-baseline gap-1">
          <span className="font-mono text-sm tabular-nums">{num(d.doc_count) ?? "?"}</span>
          <span className="text-xs text-fg-muted">vectors of</span>
          <span className="font-mono text-sm tabular-nums">{num(d.dim) ?? "?"}</span>
          <span className="text-xs text-fg-muted">dims</span>
        </span>
        {embeddingCounts(d) ? <span className="text-xs text-fg-muted">{embeddingCounts(d)}</span> : null}
      </div>
      <dl data-testid="index-descriptor" className="grid grid-cols-[120px_minmax(0,1fr)] gap-px bg-hairline">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="meta flex h-row items-center bg-surface px-3">{k}</dt>
            <dd className="flex min-h-[28px] min-w-0 items-center bg-surface px-3 font-mono text-xs break-all text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </Frame>
  )
}
