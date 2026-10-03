/**
 * FLIP: First, Last, Invert, Play. Motion 4 of the design contract: a hit the
 * reranker moved slides from its old place to its new one, so "up from #3"
 * is seen as well as read.
 *
 * Elements are matched by their `data-flip-key`. `play` reads where each one
 * is now, puts it back where it was with a transform, then animates that
 * transform to nothing with the Web Animations API. Only `transform` moves.
 * Under `prefers-reduced-motion: reduce` it does nothing: the badges carry the
 * information.
 */

/** The part of a DOMRect a move needs. */
export interface Rect {
  left: number
  top: number
  height?: number
}

/** Each keyed element's box, by its `data-flip-key`. */
export function measure(container: HTMLElement, selector: string): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>()
  container.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const key = el.dataset.flipKey
    if (key) out.set(key, el.getBoundingClientRect())
  })
  return out
}

/** The move that puts an element at `after` back at `before`. */
export function inverse(before: Rect, after: Rect): { dx: number; dy: number } {
  return { dx: before.left - after.left, dy: before.top - after.top }
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function play(container: HTMLElement, before: ReadonlyMap<string, Rect>, timing: { duration: number; easing: string }): void {
  if (reducedMotion()) return
  container.querySelectorAll<HTMLElement>("[data-flip-key]").forEach((el) => {
    const from = before.get(el.dataset.flipKey ?? "")
    if (!from) return
    const { dx, dy } = inverse(from, el.getBoundingClientRect())
    if (dx === 0 && dy === 0) return
    // jsdom has no Web Animations API.
    el.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing)
  })
}
