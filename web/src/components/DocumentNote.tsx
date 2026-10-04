import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { openDocumentMenu, useDocument, type DocStatus } from "@/state/document"

/** A run needs a document that exists: none, or a missing one, blocks it. */
export function needsDocument(status: DocStatus): boolean {
  return status === "empty" || status === "missing"
}

/**
 * The one stale-tone note Build, Compare and Evaluate share about the
 * document in the header's bar. Missing or none: what it blocks, and a "Pick
 * a document" button that opens the bar's menu. Changed since the results on
 * the page were made: says so, with no button. Otherwise nothing.
 */
export function DocumentNote({ action, changed = false, className }: { action: string; changed?: boolean; className?: string }) {
  const { doc, status } = useDocument()
  const blocked = needsDocument(status)
  if (!blocked && !(changed && doc)) return null
  return (
    <div
      role="status"
      data-testid="document-note"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-stale-wash px-3 py-2 text-sm text-stale", className)}
    >
      <p className="min-w-0 flex-[1_1_260px]">
        {status === "missing" ? (
          <>
            <b className="font-semibold">{doc?.filename} is missing.</b> Uploads on the demo expire. Pick a document in the bar above to {action}.
          </>
        ) : status === "empty" ? (
          <>Pick a document in the bar above to {action}.</>
        ) : (
          <>
            The document changed to <b className="font-semibold">{doc?.filename}</b>. The results below are from the old one. Run again to update
            them.
          </>
        )}
      </p>
      {blocked ? (
        <Button variant="outline" size="sm" className="border-stale bg-transparent text-stale hover:bg-surface-hover" onClick={openDocumentMenu}>
          Pick a document
        </Button>
      ) : null}
    </div>
  )
}
