import { useLayoutEffect, useState, type RefObject } from "react"

/** A recipe column's minimum width in px. */
export const COLUMN_MIN = 300

/** Below this width Compare shows one recipe at a time, whatever the count. */
export const TABS_BELOW = 820

/**
 * Whether `n` recipe columns fit side by side in the element: it must be at
 * least `TABS_BELOW` wide and give each column `COLUMN_MIN`. Kept current as
 * the element resizes. True without `ResizeObserver` (jsdom), as `useWide` is
 * without `matchMedia`. It measures before the first paint, so a narrow
 * screen never draws every column for a frame.
 */
export function useColumnsFit(ref: RefObject<HTMLElement | null>, n: number): boolean {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver !== "function") return
    // Measure now: a state update in a layout effect renders again before the first paint.
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width
      if (typeof w === "number") setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width === null || width >= Math.max(TABS_BELOW, n * COLUMN_MIN)
}
