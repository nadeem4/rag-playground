/**
 * The slope between the search order and the reranked order (spec section 6):
 * one cubic per kept piece across the gutter between the two lists, from the
 * gutter's left edge at the height of its search swatch to the gutter's right
 * edge at the height of its reranked swatch. The control points sit 40 px out
 * from each end so the line leaves and lands level. A line never enters either
 * column, so it never crosses text.
 */

/** The part of a DOMRect the geometry reads. */
export type Box = Pick<DOMRect, "left" | "top" | "width" | "height">

/** How a piece moved: rose, fell, or stayed in place. */
export type SlopeKind = "up" | "down" | "same"

export interface SlopePath {
  id: string
  d: string
  kind: SlopeKind
}

/** How far out the control points sit from each end, in px. */
export const REACH = 40

/** How far inside the gutter's edges a line starts and ends, in px. */
export const INSET = 2

/** The draw's length, in ms (spec section 6). */
export const DRAW_MS = 360

/**
 * The lines, in the right list's order, with coordinates relative to `box`.
 * A piece on one side only, or one without a movement (a Not kept slip), gets
 * no line.
 */
export function pairs(
  left: ReadonlyMap<string, Box>,
  right: ReadonlyMap<string, Box>,
  box: Box,
  gutter: Box,
  movements: ReadonlyMap<string, SlopeKind>,
): SlopePath[] {
  const x1 = gutter.left - box.left + INSET
  const x2 = gutter.left + gutter.width - box.left - INSET
  const out: SlopePath[] = []
  for (const [id, b] of right) {
    const a = left.get(id)
    const kind = movements.get(id)
    if (!a || !kind) continue
    const y1 = a.top + a.height / 2 - box.top
    const y2 = b.top + b.height / 2 - box.top
    out.push({ id, kind, d: `M ${x1},${y1} C ${x1 + REACH},${y1} ${x2 - REACH},${y2} ${x2},${y2}` })
  }
  return out
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Draw every line in `svg` from nothing to its full length: a dash as long as
 * the line, its offset animated from the length to 0 with the Web Animations
 * API. Nothing is kept once it ends, so a stayed line's own dash comes back.
 * Under reduced motion it does nothing: the lines are there at full length.
 */
export function drawSlope(svg: Element, timing: { duration: number; easing: string }): void {
  if (reducedMotion()) return
  svg.querySelectorAll<SVGPathElement>("path").forEach((p) => {
    // jsdom has neither SVG geometry nor the Web Animations API.
    const len = p.getTotalLength?.()
    if (!len) return
    p.animate?.(
      [
        { strokeDasharray: `${len}`, strokeDashoffset: len },
        { strokeDasharray: `${len}`, strokeDashoffset: 0 },
      ],
      timing,
    )
  })
}
