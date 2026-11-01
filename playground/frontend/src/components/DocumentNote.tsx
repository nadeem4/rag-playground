import { useDemo } from "@/api/useDemo"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { openDocumentMenu, refetchLink, useDocStatus, useDocument, type DocRef, type DocStatus } from "@/state/document"

/** A run needs a document that exists: none, or a missing one, blocks it. */
export function needsDocument(status: DocStatus): boolean {
  return status === "empty" || status === "missing"
}

/**
 * The one stale-tone note Build, Compare and Evaluate share about the page's
 * document. Missing or none: what it blocks, and a "Pick a file or link" button
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
  // Any of the pipeline's documents that is gone blocks the run, and the note names it.
  const doc = own !== undefined ? own : (store.missing ?? store.doc)
  const status = own !== undefined ? ownStatus : store.missing ? "missing" : store.status
  const recoveredNote = store.recoveredNote
  const demo = useDemo()
  const blocked = needsDocument(status)
  // A document added from a link is fetched again, not uploaded again; the page's own document is not.
  const link = own === undefined && status === "missing" && doc?.url ? doc : null
  const refused = link ? store.refused.has(link.sha) : false
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
        {link ? (
          <>
            <b className="font-semibold">{link.filename} is missing.</b> {refused ? store.refused.get(link.sha) || "Fetch it again, or pick another document." : "Fetching it again."}
          </>
        ) : status === "missing" ? (
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
      {link && refused ? (
        <Button variant="outline" size="sm" className="border-stale bg-transparent text-stale hover:bg-surface-hover" onClick={() => void refetchLink(link)}>
          Fetch again
        </Button>
      ) : null}
      {blocked ? (
        <Button variant="outline" size="sm" className="border-stale bg-transparent text-stale hover:bg-surface-hover" onClick={openDocumentMenu}>
          Pick a file or link
        </Button>
      ) : null}
    </div>
  )
}
