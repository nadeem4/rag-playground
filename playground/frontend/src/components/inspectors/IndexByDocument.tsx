import { useEffect, useState } from "react"

import { runsAs, type DocNodeState } from "@/api/runState"
import { loadPayload } from "@/api/useArtifact"
import { FileTag } from "@/components/FileTag"
import { fmt } from "@/components/inspectors/status"
import type { FileInfo } from "@/lib/files"

export interface DocumentChunks {
  file: FileInfo
  /** Null while the count loads. */
  chunks: number | null
}

/** On the Index pane of a pipeline with several documents: how many chunks each one made, and the total. */
export function IndexByDocument({ rows }: { rows: DocumentChunks[] }) {
  if (rows.length < 2) return null
  const counted = rows.every((r) => r.chunks !== null)
  const total = rows.reduce((sum, r) => sum + (r.chunks ?? 0), 0)
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
            <td className="py-1 text-right font-mono tabular-nums">{r.chunks === null ? <span className="text-fg-muted">Counting</span> : fmt(r.chunks)}</td>
          </tr>
        ))}
        {counted ? (
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

/** Each file's chunk count, read from its own chunk result; null until it loads or when the file has no result. */
function useChunkCounts(files: readonly FileInfo[], documents: Record<string, DocNodeState> | undefined): Record<string, number | null> {
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const key = files.map((f) => `${f.sha}=${artifactOf(f, documents) ?? ""}`).join("|")
  useEffect(() => {
    let live = true
    for (const f of files) {
      const id = artifactOf(f, documents)
      if (!id) continue
      loadPayload(id)
        .then((p) => {
          const chunks = (p as { chunks?: unknown[] } | undefined)?.chunks
          if (live && Array.isArray(chunks)) setCounts((c) => ({ ...c, [f.sha]: chunks.length }))
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
    // `key` stands for files and documents.
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
  const counts = useChunkCounts(files, documents)
  return <IndexByDocument rows={files.map((file) => ({ file, chunks: counts[file.sha] ?? null }))} />
}
