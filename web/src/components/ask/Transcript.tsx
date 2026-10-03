import type { HitRowData } from "@/components/inspectors/hits"
import { Button } from "@/components/ui/button"

/**
 * Earlier questions in this tab: one entry per finished Ask, newest first.
 * Build keeps the entries, so they outlive the panel while a card is open.
 */

export interface TranscriptEntry {
  /** The run that answered it: one entry per run. */
  runId: string
  question: string
  /** `{pipeline}, {reranker}: found at #{rank}`, or the piece count when no gold is known. */
  line: string
}

/**
 * The list with `entry` added. A run already logged keeps its one entry, with
 * the newer wording (the sample's question set can answer after the run), and
 * an unchanged entry returns the same list.
 */
export function logEntry(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const at = list.findIndex((e) => e.runId === entry.runId)
  if (at === -1) return [...list, entry]
  const old = list[at]
  return old.question === entry.question && old.line === entry.line ? list : list.map((e, i) => (i === at ? entry : e))
}

/** The same passage as a parser with other habits would have written it, as the eval step reads it. */
const normalise = (text: string) => text.replace(/-\s*\n\s*/g, "").split(/\s+/).filter(Boolean).join(" ").toLowerCase()

/** The rank of the first piece that holds any gold passage, or null. */
export function goldRank(rows: readonly HitRowData[], golds: readonly string[]): number | null {
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
              <p className="font-mono text-xs text-fg-muted">{e.line}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onAskAgain(e.question)}>
              Ask again
            </Button>
          </li>
        ))}
      </ol>
    </details>
  )
}
