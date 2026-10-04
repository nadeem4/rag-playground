import { useLayoutEffect, useRef, useState, type RefObject } from "react"

import { pairs, type Box, type SlopeKind, type SlopePath } from "@/lib/slope"

/** Each swatch in one column, by piece id. The swatch is the element that carries `data-id`. */
function swatches(root: HTMLElement, column: string): Map<string, Box> {
  const out = new Map<string, Box>()
  root.querySelectorAll<HTMLElement>(`[data-column="${column}"] [data-id]`).forEach((el) => out.set(el.dataset.id!, el.getBoundingClientRect()))
  return out
}

const NONE: SlopePath[] = []

/**
 * The slope's lines, measured from the swatches the browser drew inside
 * `containerRef`: on mount, when the rerank result changes, when the container
 * resizes, and once the fonts have landed (line breaks move with them).
 * Nothing while the comparison is closed.
 */
export function useSlope(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  rerankId: string | undefined,
  movements: ReadonlyMap<string, SlopeKind>,
): SlopePath[] {
  const [paths, setPaths] = useState<SlopePath[]>(NONE)
  // The movements follow the rerank result; a ref keeps a new Map each render from remeasuring.
  const moves = useRef(movements)
  moves.current = movements
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!open || !root) {
      setPaths(NONE)
      return
    }
    let key = ""
    const measure = () => {
      const next = pairs(swatches(root, "search"), swatches(root, "reranked"), root.getBoundingClientRect(), moves.current)
      const nextKey = next.map((p) => `${p.id} ${p.kind} ${p.d}`).join("|")
      if (nextKey === key) return
      key = nextKey
      setPaths(next)
    }
    measure()
    let cancelled = false
    document.fonts?.ready.then(() => {
      if (!cancelled) measure()
    })
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    ro?.observe(root)
    return () => {
      cancelled = true
      ro?.disconnect()
    }
  }, [containerRef, open, rerankId])
  return open ? paths : NONE
}
