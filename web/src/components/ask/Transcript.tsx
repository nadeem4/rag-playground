import type { Registry } from "@/api/types"
import type { HitRowData } from "@/components/inspectors/hits"
import { Button } from "@/components/ui/button"
import { askNodes, signature, terminalNode, type PipelineGraph } from "@/state/graph"

import { rerankLabel } from "./AskResults"

/**
 * Earlier questions in this tab: one entry per finished Ask, newest first.
 * Build keeps the entries, so they outlive the panel while a card is open.
 */

/** One finished Ask, frozen with the settings and the ranked pieces its run used. */
export interface TranscriptEntry {
  /** The run that answered it: one entry per run. */
  runId: string
  question: string
  /** The saved pipeline's name, or `Working copy`. */
  pipeline: string
  /** The reranker's label, or `no rerank`. */
  reranker: string
  /** The final ranked list of the run, kept so a late gold rank is read from this run's pieces. */
  rows: { rank: number; text: string }[]
  /** The rank of the first piece holding the gold, when the question is the sample's. */
  found: number | null
}

/**
 * What an Ask was asked with, taken when Ask is pressed: the entry's labels
 * come from here, never from the settings when the run finishes.
 */
export interface AskSnapshot {
  runId: string
  question: string
  pipeline: string
  reranker: string
  /** The question's path through the graph (`askSignature`) when Ask was pressed. */
  signature: string
}

/** The use case's signature: its settings and those of every step above it, the question included. */
export function askSignature(graph: PipelineGraph, registry: Registry): string {
  const end = terminalNode(graph)
  return end ? signature(graph, end.id, registry) : ""
}

/** The snapshot of the graph as Ask is pressed, without the run id the server will give. */
export function askSnapshot(graph: PipelineGraph, registry: Registry, pipeline: string): Omit<AskSnapshot, "runId"> {
  const { query, rerank } = askNodes(graph)
  return {
    question: String(query?.config.text ?? ""),
    pipeline,
    reranker: rerank ? rerankLabel(rerank.transform) : "no rerank",
    signature: askSignature(graph, registry),
  }
}

/**
 * The list with `entry` added. A run already logged keeps its entry as it was;
 * the only later change is a gold rank it did not have yet (the sample's
 * question set can answer after the run). An unchanged list is returned as is.
 */
export function logEntry(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const at = list.findIndex((e) => e.runId === entry.runId)
  if (at === -1) return [...list, entry]
  const old = list[at]
  if (old.found !== null || entry.found === null) return list
  return list.map((e, i) => (i === at ? { ...old, found: entry.found } : e))
}

/** The same passage as a parser with other habits would have written it, as the eval step reads it. */
const normalise = (text: string) => text.replace(/-\s*\n\s*/g, "").split(/\s+/).filter(Boolean).join(" ").toLowerCase()

/** The rank of the first piece that holds any gold passage, or null. */
export function goldRank(rows: readonly Pick<HitRowData, "rank" | "text">[], golds: readonly string[]): number | null {
  const wanted = golds.map(normalise).filter(Boolean)
  if (!wanted.length) return null
  const hit = rows.find((r) => {
    const text = normalise(r.text)
    return wanted.some((g) => text.includes(g))
  })
  return hit ? hit.rank : null
}

export function transcriptLine(pipeline: string, reranker: string, found: number | null, pieces: number): string {
  return `${pipeline}, ${reranker}: ${found === null ? `${pieces} ${pieces === 1 ? "piece" : "pieces"}` : `found at #${found}`}`
}

export function Transcript({ entries, onAskAgain }: { entries: TranscriptEntry[]; onAskAgain: (question: string) => void }) {
  if (!entries.length) return null
  return (
    <details className="border-t border-hairline pt-3">
      <summary className="cursor-pointer text-sm font-semibold">{`Earlier questions in this tab (${entries.length})`}</summary>
      <ol className="mt-2 flex flex-col">
        {[...entries].reverse().map((e) => (
          <li key={e.runId} data-testid="transcript-entry" className="flex flex-wrap items-start justify-between gap-2 border-b border-hairline py-2 last:border-b-0">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm text-fg">{e.question}</p>
              <p className="font-mono text-xs text-fg-muted">{transcriptLine(e.pipeline, e.reranker, e.found, e.rows.length)}</p>
            </div>
            <Button variant="outline" size="sm" aria-label={`Ask again: ${e.question}`} onClick={() => onAskAgain(e.question)}>
              Ask again
            </Button>
          </li>
        ))}
      </ol>
    </details>
  )
}
