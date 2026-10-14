import type { ChatCitation, Element, FindResult, PdfRect } from "@/api/types"

/**
 * The pure half of the PDF page view. PDF space is points with the origin at
 * the page's bottom-left and y growing UP; CSS is pixels from the top-left
 * with y growing DOWN. Rects are (left, bottom, right, top), the convention of
 * `Element.bbox` and of the find endpoint (plan I-9).
 */

export interface CssBox {
  left: number
  top: number
  width: number
  height: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * A PDF rect in CSS pixels on a page drawn `scale` CSS px per point. The y
 * flip: a rect's CSS top is the page height minus its PDF top. Corners given
 * in either order are normalised, and the box is clipped to the page.
 */
export function pdfRectToCss(rect: PdfRect, page: { width: number; height: number }, scale: number): CssBox {
  const [a, b, c, d] = rect
  const x0 = clamp(Math.min(a, c), 0, page.width)
  const x1 = clamp(Math.max(a, c), 0, page.width)
  const y0 = clamp(Math.min(b, d), 0, page.height)
  const y1 = clamp(Math.max(b, d), 0, page.height)
  return {
    left: x0 * scale,
    top: (page.height - y1) * scale,
    width: (x1 - x0) * scale,
    height: (y1 - y0) * scale,
  }
}

// ------------------------------------------------------ show in pdf --------

export interface Region {
  page: number
  rect: PdfRect
}

export interface ElementRegions {
  /** Every element that has both a page and a bbox. */
  regions: Region[]
  /** Pages the elements are on, ascending, whether or not they have a bbox. */
  pages: number[]
  /** How many of the ids were found in the document. */
  found: number
  /** Some elements were found but none of them has a bbox: the parser gives none. */
  noBbox: boolean
}

/** Where a chunk's source elements sit on the pages of the PDF. */
export function regionsForElements(elements: readonly Element[], ids: readonly string[]): ElementRegions {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const found = ids.map((id) => byId.get(id)).filter((e): e is Element => e !== undefined)
  const regions = found
    .filter((e) => e.page !== null && e.bbox !== null)
    .map((e) => ({ page: e.page as number, rect: e.bbox as PdfRect }))
  const pages = [...new Set(found.map((e) => e.page).filter((p): p is number => p !== null))].sort((x, y) => x - y)
  return { regions, pages, found: found.length, noBbox: found.length > 0 && regions.length === 0 }
}

// ---------------------------------------------------------- citations ------

export type CitationHighlight =
  | { how: "text"; matched: "exact" | "normalized"; rects: PdfRect[] }
  | { how: "element"; rects: PdfRect[] }
  | { how: "none"; rects: PdfRect[] }

/**
 * What to highlight for a citation: the cited text where the page search found
 * it, else the whole element the citation came from (its bbox), else nothing.
 * `find` null means the search failed or has not answered.
 */
export function citationHighlight(find: FindResult | null, citation: Pick<ChatCitation, "bbox">): CitationHighlight {
  if (find && find.matched !== "none" && find.rects.length > 0) return { how: "text", matched: find.matched, rects: find.rects }
  if (citation.bbox) return { how: "element", rects: [citation.bbox] }
  return { how: "none", rects: [] }
}

export function highlightWords(h: CitationHighlight): string {
  switch (h.how) {
    case "text":
      return h.matched === "exact"
        ? "Showing the cited text, found on the page as quoted."
        : "Showing the cited text, found after collapsing whitespace and joining hyphenated line ends."
    case "element":
      return "The cited text was not found on the page. Showing the whole element it came from instead."
    case "none":
      return "The cited text was not found on the page, and its element has no position, so nothing is highlighted."
  }
}
