import { useState, type MouseEvent } from "react"
import { Eye } from "lucide-react"

import { v2 } from "@/api/v2"
import { usePageSizes } from "@/api/usePdf"
import { Button } from "@/components/ui/button"
import { formatOf, hasPages } from "@/lib/formats"
import { cn } from "@/lib/utils"
import { useDocStatus, useDocument, type DocRef } from "@/state/document"

import { DocumentPreview } from "./DocumentPreview"

/** What the element says about a document: its title, file, pages, and whether it is a sample, an upload or a link, or gone. */
export interface DocumentFacts {
  title: string
  filename: string
  /** Null while the count loads, and when the file is gone. */
  pages: number | null
  kind: "Sample" | "Your upload" | "From a link"
  removed: boolean
  /** The lists say the server has the file. Until then no page is asked for, so a gone upload never fails a request. */
  known: boolean
}

/** A link's host, such as "en.wikipedia.org"; the link itself when it cannot be read. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** A readable title from a file name: "my-chunking-notes.pdf" reads "My chunking notes". */
export function titleFromFilename(filename: string): string {
  const words = (formatOf(filename) ? filename.replace(/\.[^.]+$/, "") : filename).replace(/[-_]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : filename
}

export function useDocumentFacts(doc: DocRef, removed?: boolean): DocumentFacts {
  const { samples, uploads } = useDocument()
  const status = useDocStatus(doc)
  const gone = removed ?? status === "missing"
  const sample = samples?.find((s) => s.sha === doc.sha)
  const link = uploads?.find((u) => u.sha === doc.sha)?.origin_url
  const known = !gone && status === "ready"
  // A sample knows its page count; an upload asks the server once the lists say it is there. A document with no pages is never asked.
  const sizes = usePageSizes(!known || sample || !hasPages(doc.filename) ? null : doc.sha)
  return {
    title: sample?.title ?? (link ? hostOf(link) : titleFromFilename(doc.filename)),
    filename: doc.filename,
    pages: gone ? null : (sample?.pages ?? (sizes.kind === "ready" ? sizes.data.length : null)),
    kind: sample ? "Sample" : link ? "From a link" : "Your upload",
    removed: gone,
    known,
  }
}

/** The facts line: the file name, the page count, and a tag. */
export function FactsLine({ facts }: { facts: DocumentFacts }) {
  return (
    <span data-testid="document-facts" className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
      <span className="min-w-0 font-mono text-2xs break-words">{facts.filename}</span>
      {facts.pages !== null ? <span>{facts.pages === 1 ? "1 page" : `${facts.pages} pages`}</span> : null}
      <span
        data-testid={facts.removed ? "document-removed" : undefined}
        className={cn("rounded-swatch px-1 text-2xs font-medium", facts.removed ? "bg-removed text-removed-text" : "bg-surface-elevated text-fg-muted")}
      >
        {facts.removed ? "Removed from the server" : facts.kind}
      </span>
    </span>
  )
}

/** A small picture of page 1, or a blank page until the file is known to be there. A document with no pages shows its kind, such as DOCX. */
function Thumb({ doc, known, className, label }: { doc: DocRef; known: boolean; className: string; label?: boolean }) {
  const box = cn("aspect-[612/792] shrink-0 rounded-[3px] bg-white object-cover shadow-[0_0_0_1px_var(--hairline)]", className)
  if (!hasPages(doc.filename)) {
    return (
      <span aria-hidden className={cn(box, "grid place-items-center bg-surface-elevated font-mono text-[9px] font-semibold text-fg-muted")}>
        {label ? formatOf(doc.filename)?.toUpperCase() : null}
      </span>
    )
  }
  return known ? <img src={v2.pageImageUrl(doc.sha, 1, 0.25)} alt="" aria-hidden className={box} /> : <span aria-hidden className={box} />
}

/**
 * The one Document element, wherever a document is named. Full, where
 * documents are listed: page 1's picture, the title, the facts line and a
 * Preview button. Compact, where space is tight: the picture and the title
 * inline, with a small Preview beside them. Preview opens the same sheet
 * everywhere. An upload the server no longer has keeps its name, says so, and
 * cannot be previewed.
 */
export function DocumentItem({
  doc,
  size = "full",
  missing,
}: {
  doc: DocRef
  size?: "full" | "compact"
  /** The page already knows whether the file is gone (Build's Document step). Left out, the element asks the store. */
  missing?: boolean
}) {
  const facts = useDocumentFacts(doc, missing)
  const [open, setOpen] = useState(false)
  const preview = (e: MouseEvent<HTMLButtonElement>) => {
    // Focus first, so the sheet gives it back on close, even where a click does not focus a button.
    e.currentTarget.focus()
    setOpen(true)
  }
  const button = (
    <Button
      variant={size === "full" ? "outline" : "ghost"}
      size={size === "full" ? "default" : "sm"}
      className={cn(
        "disabled:pointer-events-auto disabled:cursor-not-allowed",
        size === "full" ? "border-field-border bg-surface-raised hover:bg-surface-hover" : "text-primary hover:bg-accent-wash",
      )}
      aria-label={`Preview ${facts.title}`}
      title={facts.removed ? "Upload it again to preview it" : undefined}
      disabled={facts.removed}
      onClick={preview}
    >
      <Eye aria-hidden strokeWidth={1.75} className={size === "full" ? "size-4" : "size-[14px]"} />
      Preview
    </Button>
  )
  return (
    <>
      {size === "full" ? (
        <div
          data-testid="document-item"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-hairline bg-surface-raised py-2 pr-3 pl-2"
        >
          <Thumb doc={doc} known={facts.known} className="w-[36px]" label />
          <span className="flex min-w-0 flex-[1_1_10rem] flex-col">
            <span className="text-sm font-semibold [overflow-wrap:anywhere] text-fg">{facts.title}</span>
            <FactsLine facts={facts} />
          </span>
          <span className="ml-auto">{button}</span>
        </div>
      ) : (
        <span data-testid="document-item" className="inline-flex max-w-full min-w-0 items-center gap-1">
          <Thumb doc={doc} known={facts.known} className="w-[18px] rounded-[2px]" />
          <span className="min-w-0 truncate text-sm font-semibold text-fg" title={facts.title}>
            {facts.title}
          </span>
          {button}
        </span>
      )}
      {open ? <DocumentPreview doc={doc} facts={facts} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
