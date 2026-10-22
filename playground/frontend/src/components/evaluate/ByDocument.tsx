import type { DocumentTotals } from "@/api/types"
import { FileTag } from "@/components/FileTag"
import { fileOf, type FileInfo } from "@/lib/files"

/**
 * An evaluation's totals by document, for a pipeline with several (spec
 * "Evaluate (part 4a)"): each document's questions found of its total, with a
 * bar, then the questions naming no document. The numbers are the server's
 * (`by_document`); nothing is added up here.
 */
export function ByDocument({ rows, files }: { rows: readonly DocumentTotals[]; files: readonly FileInfo[] }) {
  return (
    <table aria-label="Found by document" className="w-full max-w-[40rem] border-collapse text-sm">
      <thead>
        <tr className="text-left text-xs text-fg-muted">
          <th className="py-1 pr-3 font-medium">By document</th>
          <th className="py-1 pr-3 font-medium">Found</th>
          <th className="w-2/5 py-1 font-medium">
            <span className="sr-only">Share found</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const file = fileOf(files, r.document)
          return (
            <tr key={r.document ?? "none"} className="border-t border-hairline">
              <td className="min-w-0 py-1.5 pr-3">{file ? <FileTag file={file} /> : <NoDocument />}</td>
              <td className="py-1.5 pr-3 font-mono whitespace-nowrap tabular-nums">
                {r.found} of {r.total}
              </td>
              <td className="py-1.5">
                <span aria-hidden className="block h-[8px] min-w-[60px] overflow-hidden rounded-full bg-surface-elevated">
                  <span className="block h-full bg-primary" style={{ width: `${r.total ? (r.found / r.total) * 100 : 0}%` }} />
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** The tag for questions that name no document, in the file tag's shape without a colour. */
export function NoDocument({ text = "no document named" }: { text?: string }) {
  return <span className="inline-flex items-center rounded-[4px] bg-surface-elevated px-2 align-baseline font-mono text-2xs text-fg-muted">{text}</span>
}
