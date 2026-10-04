import { useLayoutEffect, useState, type RefObject } from "react"

/** A recipe column's minimum width in px. */
export const COLUMN_MIN = 300

/** Below this width Compare shows one recipe at a time, whatever the count. */
export const TABS_BELOW = 820

/**
 * Whether `n` recipe columns fit side by side in the element: it must be at
 * least `TABS_BELOW` wide and give each column `COLUMN_MIN`. Kept current as
 * the element resizes. True without `ResizeObserver` (jsdom), as `useWide` is
 * without `matchMedia`, and true until the first measure arrives.
 */
export function useColumnsFit(ref: RefObject<HTMLElement | null>, n: number): boolean {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver !== "function") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width
      if (typeof w === "number") setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width === null || width >= Math.max(TABS_BELOW, n * COLUMN_MIN)
}
