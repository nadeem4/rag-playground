import { useLayoutEffect, type RefObject } from "react"

/**
 * The position spine (design contract §9). Marks are laid out by MEASURING the
 * rendered DOM, never by character offsets, so they register with whatever the
 * browser actually drew: wrapped lines, fonts, zoom.
 *
 * Markup contract, inside one root:
 *   [data-spine]                    the gutter; the origin of every mark
 *   [data-target="<n>"]             a measured text element (a segment or a block)
 *   [data-first][data-last]         a mark spanning targets first..last
 *     [data-anchor="mid"]           ...placed at the vertical midpoint instead
 *
 * The spine is a sibling of the text inside the SAME scrolling content, so it
 * scrolls with the text for free. Positions are relative to the spine's own
 * box, which makes them scroll-invariant: no scroll listener exists or is needed.
 * A ResizeObserver on the root remeasures on reflow; nothing goes through React
 * state, the marks' styles are written directly.
 */
export function layoutSpine(root: HTMLElement): void {
  const spine = root.querySelector<HTMLElement>("[data-spine]")
  if (!spine) return
  const origin = spine.getBoundingClientRect().top
  const targets = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>("[data-target]").forEach((el) => targets.set(el.dataset.target!, el))

  spine.querySelectorAll<HTMLElement>("[data-first]").forEach((mark) => {
    const first = targets.get(mark.dataset.first!)
    const last = targets.get(mark.dataset.last!)
    if (!first || !last) return
    // Inline spans wrap: the first line box of the first target and the last
    // line box of the last one bound the mark.
    const firstRects = first.getClientRects()
    const lastRects = last.getClientRects()
    const top = (firstRects[0] ?? first.getBoundingClientRect()).top - origin
    const bottom = (lastRects[lastRects.length - 1] ?? last.getBoundingClientRect()).bottom - origin
    if (mark.dataset.anchor === "mid") {
      mark.style.top = `${(top + bottom) / 2}px`
    } else {
      mark.style.top = `${top}px`
      mark.style.height = `${Math.max(2, bottom - top)}px`
    }
  })
}

export function useSpineLayout(rootRef: RefObject<HTMLElement | null>, deps: readonly unknown[]): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => layoutSpine(root)
    measure()
    let cancelled = false
    // Geist is self-hosted with font-display: swap; line breaks move when it lands.
    document.fonts?.ready.then(() => {
      if (!cancelled) measure()
    })
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    ro?.observe(root)
    return () => {
      cancelled = true
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
