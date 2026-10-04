import { createContext, useContext, useSyncExternalStore } from "react"

/** The wide layout: the `xl` breakpoint, where the two lists sit side by side with the slope between them. */
export const WIDE_QUERY = "(min-width: 80rem)"

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {}
  const mq = matchMedia(WIDE_QUERY)
  mq.addEventListener?.("change", onChange)
  return () => mq.removeEventListener?.("change", onChange)
}

/** True without `matchMedia` (jsdom): the wide layout is the default. */
function wide(): boolean {
  return typeof matchMedia !== "function" || matchMedia(WIDE_QUERY).matches
}

/** Whether the window is at least 1280 px wide, kept current as it resizes. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, wide)
}

/**
 * Whether the panel around the comparison is wide enough to set the two lists
 * side by side: set by the docked Ask panel from its own width (640 px and
 * up). Null outside the panel, or before it has been measured.
 */
export const PanelWide = createContext<boolean | null>(null)

/** The comparison's layout: the panel's own width inside the Ask panel, else the window's (`useWide`). */
export function useComparisonWide(): boolean {
  const panel = useContext(PanelWide)
  const window = useWide()
  return panel ?? window
}
