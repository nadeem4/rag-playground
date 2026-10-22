import type { DocRef } from "@/state/document"

/**
 * Above Build's column when the pipeline reads several documents: which
 * document's results the cards and the inspectors show. Every step runs on
 * each document; this picks the one to read. The index and Ask cover them all.
 */
export function ShowingDocument({ documents, value, onChange }: { documents: readonly DocRef[]; value: string; onChange: (sha: string) => void }) {
  return (
    <div data-testid="showing-document" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-2">
      <label htmlFor="showing-document" className="text-xs text-fg-muted">
        Showing the steps for
      </label>
      <select
        id="showing-document"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[32px] max-w-full min-w-0 rounded-control border border-field-border bg-surface px-2 text-sm text-fg outline-none focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
      >
        {documents.map((d) => (
          <option key={d.sha} value={d.sha}>
            {d.filename}
          </option>
        ))}
      </select>
      <span className="text-xs text-fg-muted">
        {documents.length} documents, one index.
      </span>
    </div>
  )
}
