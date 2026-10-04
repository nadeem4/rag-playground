/**
 * The slope between the search order and the reranked order (spec section 6):
 * one cubic per kept piece, from the right centre of its swatch in the search
 * column to the left centre of its swatch in the reranked column, with control
 * points 40 px out from each end so the line leaves and lands level.
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

/**
 * The lines, in the right list's order, with coordinates relative to `box`.
 * A piece on one side only, or one without a movement (a Not kept slip), gets
 * no line.
 */
export function pairs(
  left: ReadonlyMap<string, Box>,
  right: ReadonlyMap<string, Box>,
  box: Box,
  movements: ReadonlyMap<string, SlopeKind>,
): SlopePath[] {
  const out: SlopePath[] = []
  for (const [id, b] of right) {
    const a = left.get(id)
    const kind = movements.get(id)
    if (!a || !kind) continue
    const x1 = a.left + a.width - box.left
    const y1 = a.top + a.height / 2 - box.top
    const x2 = b.left - box.left
    const y2 = b.top + b.height / 2 - box.top
    out.push({ id, kind, d: `M ${x1},${y1} C ${x1 + REACH},${y1} ${x2 - REACH},${y2} ${x2},${y2}` })
  }
  return out
}
