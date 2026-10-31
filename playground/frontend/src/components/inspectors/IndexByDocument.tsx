import { useEffect, useState } from "react"

import { runsAs, type DocNodeState } from "@/api/runState"
import { loadPayload } from "@/api/useArtifact"
import { FileTag } from "@/components/FileTag"
import { fmt } from "@/components/inspectors/status"
import type { FileInfo } from "@/lib/files"

export interface DocumentChunks {
  file: FileInfo
  /** A count, or why there is none: still loading, no chunk result for this file, or the load failed. */
  chunks: number | "counting" | "missing" | "failed"
}

const WORDS = { counting: "Counting", missing: "Not run", failed: "Could not count" }

/** On the Index pane of a pipeline with several documents: how many chunks each one made, and the total. */
export function IndexByDocument({ rows }: { rows: DocumentChunks[] }) {
  if (rows.length < 2) return null
  const settled = rows.every((r) => r.chunks !== "counting")
  const total = rows.reduce((sum, r) => sum + (typeof r.chunks === "number" ? r.chunks : 0), 0)
  return (
    <table data-testid="index-by-document" className="mt-3 w-full border-collapse text-sm">
      <caption className="meta pb-1 text-left">Chunks in the index, by document</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Document</th>
          <th scope="col">Chunks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.file.sha} className="border-t border-hairline">
            <td className="min-w-0 py-1 pr-3">
              <FileTag file={r.file} />
            </td>
            <td className="py-1 text-right font-mono tabular-nums">
              {typeof r.chunks === "number" ? fmt(r.chunks) : <span className="text-fg-muted">{WORDS[r.chunks]}</span>}
            </td>
          </tr>
        ))}
        {settled ? (
          <tr className="border-t border-hairline font-medium">
            <th scope="row" className="py-1 pr-3 text-left font-medium">
              Total
            </th>
            <td className="py-1 text-right font-mono tabular-nums">{fmt(total)}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}

/** Chunk counts by the chunk result's artifact id, so a new result is counted afresh. */
function useChunkCounts(ids: readonly string[]): Record<string, number | "failed"> {
  const [counts, setCounts] = useState<Record<string, number | "failed">>({})
  const key = ids.join("|")
  useEffect(() => {
    let live = true
    for (const id of ids) {
      loadPayload(id)
        .then((p) => {
          const chunks = (p as { chunks?: unknown[] } | undefined)?.chunks
          if (live) setCounts((c) => ({ ...c, [id]: Array.isArray(chunks) ? chunks.length : "failed" }))
        })
        .catch(() => {
          if (live) setCounts((c) => ({ ...c, [id]: "failed" }))
        })
    }
    return () => {
      live = false
    }
    // `key` stands for ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return counts
}

function artifactOf(file: FileInfo, documents: Record<string, DocNodeState> | undefined): string | undefined {
  const name = documents ? Object.keys(documents).find((n) => runsAs(file.filename, n, file.sha)) : undefined
  return name ? documents![name].artifact_id : undefined
}

/** The table with its counts loaded from the Chunk step's per-document results. */
export function IndexDocuments({ files, documents }: { files: readonly FileInfo[]; documents: Record<string, DocNodeState> | undefined }) {
  const ids = files.map((f) => artifactOf(f, documents))
  const counts = useChunkCounts(ids.filter((i): i is string => Boolean(i)))
  return <IndexByDocument rows={files.map((file, i) => ({ file, chunks: ids[i] ? (counts[ids[i]!] ?? "counting") : "missing" }))} />
}
