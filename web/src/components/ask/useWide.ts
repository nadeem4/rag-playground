import { useSyncExternalStore } from "react"

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
