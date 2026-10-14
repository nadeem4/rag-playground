import type { ParsedDoc } from "@/api/types"

import { regionsForElements } from "./geometry"
import { PdfPageView } from "./PdfPageView"

/**
 * "Show in PDF" for a chunk or a hit: the bboxes of the parsed elements the
 * chunk was cut from, on the pages of the uploaded file. The file is the
 * parsed document's `source_id`, the sha it was uploaded under.
 */
export function ElementsInPdf({
  doc,
  elementIds,
  pageSpan,
  slot,
  title,
  onClose,
}: {
  doc: ParsedDoc
  elementIds: readonly string[]
  pageSpan: [number, number] | null
  slot: number | null
  title: string
  onClose: () => void
}) {
  const r = regionsForElements(doc.elements, elementIds)
  const first = r.regions[0]?.page ?? r.pages[0] ?? pageSpan?.[0] ?? 1
  const parser = typeof doc.parser_meta?.parser === "string" ? doc.parser_meta.parser : "This parser"

  let notice: string | undefined
  if (elementIds.length === 0) {
    notice = `The chunker recorded no source elements for this chunk, so there is nothing to highlight. Showing page ${first}.`
  } else if (r.found === 0) {
    notice = `None of this chunk's source elements are in the parsed document, so there is nothing to highlight. Showing page ${first}.`
  } else if (r.noBbox) {
    notice = `${parser} does not record where text sits on the page, so there is nothing to highlight. Showing page ${first}, where this chunk starts.`
  } else if (r.regions.length < r.found) {
    notice = `${r.found - r.regions.length} of ${r.found} source elements have no position and are not highlighted.`
  }

  return (
    <PdfPageView
      key={`${doc.source_id}:${elementIds.join(",")}`}
      sha={doc.source_id}
      initialPage={first}
      highlights={r.regions}
      slot={slot}
      title={title}
      notice={notice}
      onClose={onClose}
    />
  )
}
