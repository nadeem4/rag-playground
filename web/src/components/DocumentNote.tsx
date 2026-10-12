import { useDemo } from "@/api/useDemo"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { openDocumentMenu, useDocStatus, useDocument, type DocRef, type DocStatus } from "@/state/document"

/** A run needs a document that exists: none, or a missing one, blocks it. */
export function needsDocument(status: DocStatus): boolean {
  return status === "empty" || status === "missing"
}

/**
 * The one stale-tone note Build, Compare and Evaluate share about the page's
 * document. Missing or none: what it blocks, and a "Pick a document" button
 * that opens the page's Document control menu. Changed since the results on
 * the page were made: says so, with no button. A sample saved with an old
 * fingerprint that just moved to its current copy: one status-tone line.
 * Otherwise nothing.
 */
export function DocumentNote({
  action,
  changed = false,
  className,
  where = "above",
  doc: own,
}: {
  action: string
  changed?: boolean
  className?: string
  /** Where the document is picked: the Document line above on Compare, the Document step on Build, Documents on Evaluate. */
  where?: string
  /** A page's own document (Evaluate trying a pipeline on another file), judged instead of the pipeline on Build's. */
  doc?: DocRef | null
}) {
  const store = useDocument()
  const ownStatus = useDocStatus(own ?? null)
  const doc = own !== undefined ? own : store.doc
  const status = own !== undefined ? ownStatus : store.status
  const recoveredNote = store.recoveredNote
  const demo = useDemo()
  const blocked = needsDocument(status)
  if (!blocked && !(changed && doc)) {
    return recoveredNote ? (
      <p role="status" data-testid="document-note" className={cn("rounded-control bg-surface-hover px-3 py-2 text-sm text-fg-muted", className)}>
        {recoveredNote}
      </p>
    ) : null
  }
  return (
    <div
      role="status"
      data-testid="document-note"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-stale-wash px-3 py-2 text-sm text-stale", className)}
    >
      <p className="min-w-0 flex-[1_1_260px]">
        {status === "missing" ? (
          <>
            <b className="font-semibold">{doc?.filename} is missing.</b>
            {demo ? " Uploads on the demo expire." : ""} Pick a document {where} to {action}.
          </>
        ) : status === "empty" ? (
          <>Pick a document {where} to {action}.</>
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
