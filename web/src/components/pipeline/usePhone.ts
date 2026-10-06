import { useSyncExternalStore } from "react"

/** Below `md`: one column, where Build's output opens in a sheet instead of a pane beside the cards. */
export const PHONE_QUERY = "(max-width: 47.99rem)"

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {}
  const mq = matchMedia(PHONE_QUERY)
  mq.addEventListener?.("change", onChange)
  return () => mq.removeEventListener?.("change", onChange)
}

/** False without `matchMedia` (jsdom): the two-pane layout is the default. */
function phone(): boolean {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches
}

/** Whether the window is narrower than 768 px, kept current as it resizes. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, phone)
}
