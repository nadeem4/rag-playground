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
 * `containerRef` (the grid, holding the two `[data-column]` lists and the
 * `[data-gutter]` between them): on mount, when the rerank result changes,
 * when the grid, either list or any slip resizes, and once the fonts have landed (line
 * breaks move with them). While anything inside is still animating (the lists'
 * enter rise) it waits for that to finish, so a line joins the final places.
 * Nothing while the comparison is closed, and nothing measured for an older
 * rerank result.
 */
export function useSlope(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  rerankId: string | undefined,
  movements: ReadonlyMap<string, SlopeKind>,
): SlopePath[] {
  const [state, setState] = useState<{ id?: string; paths: SlopePath[] }>({ paths: NONE })
  // The movements follow the rerank result; a ref keeps a new Map each render from remeasuring.
  const moves = useRef(movements)
  moves.current = movements
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!open || !root) return
    let cancelled = false
    let key = ""
    let waiting = false
    const measure = () => {
      if (cancelled) return
      // jsdom has no getAnimations. An endless animation never finishes, so it is not waited for.
      const running = (root.getAnimations?.({ subtree: true }) ?? []).filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity)
      if (running.length) {
        if (waiting) return
        waiting = true
        void Promise.allSettled(running.map((a) => a.finished)).then(() => {
          waiting = false
          measure()
        })
        return
      }
      const gutter = root.querySelector<HTMLElement>("[data-gutter]")
      if (!gutter) return
      const next = pairs(swatches(root, "search"), swatches(root, "reranked"), root.getBoundingClientRect(), gutter.getBoundingClientRect(), moves.current)
      const nextKey = next.map((p) => `${p.id} ${p.kind} ${p.d}`).join("|")
      if (nextKey === key) return
      key = nextKey
      setState({ id: rerankId, paths: next })
    }
    measure()
    document.fonts?.ready.then(measure)
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (ro) {
      ro.observe(root)
      // Each list and each slip: a passage that opens in the column with room to spare resizes only its slip.
      root.querySelectorAll("[data-column], [data-slip]").forEach((el) => ro.observe(el))
    }
    return () => {
      cancelled = true
      ro?.disconnect()
    }
  }, [containerRef, open, rerankId])
  return open && state.id === rerankId ? state.paths : NONE
}
