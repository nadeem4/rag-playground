import { useCallback, useEffect, useState } from "react"

/** The open recipes in a URL's `read`, one-based (`read=1,4`), as zero-based indices; null when absent. */
function readFrom(search: string): number[] | null {
  const raw = new URLSearchParams(search).get("read")
  if (raw === null) return null
  return raw
    .split(",")
    .map((x) => Number(x) - 1)
    .filter((x) => Number.isInteger(x) && x >= 0)
}

/** The current URL with `read` set to `ids`, or without it. */
function urlWith(ids: number[] | null): string {
  const q = new URLSearchParams(window.location.search)
  if (ids === null) q.delete("read")
  else q.set("read", ids.map((i) => i + 1).join(","))
  const qs = q.toString()
  return `${window.location.pathname}${qs ? `?${qs}` : ""}`
}

/**
 * The recipes open beside each other after a run, kept in the URL as `read`
 * so the browser's Back button returns to the overview. Opening pushes one
 * history entry; Previous, Next, the arrows and the chips replace it, so one
 * Back always returns to the overview. Closing goes back when the entry is
 * ours, else drops `read` in place. A `read` the page has no results for (a
 * reload or a shared link) is dropped on arrival: results live in this page.
 * Ids out of range or not finished are left out, and at most `fit` are open.
 */
export function useOpenRecipes(count: number, ready: number[], fit = 3) {
  const [raw, setRaw] = useState<number[] | null>(() => readFrom(window.location.search))

  // Arriving with a read and no results: drop it.
  useEffect(() => {
    if (readFrom(window.location.search) !== null && ready.length === 0) {
      window.history.replaceState(window.history.state, "", urlWith(null))
      setRaw(null)
    }
    // Only on arrival.
  }, [])

  useEffect(() => {
    const onPop = () => setRaw(readFrom(window.location.search))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const clean = useCallback((ids: number[]) => ids.filter((i) => i < count && ready.includes(i)).slice(0, fit), [count, ready, fit])

  const open = (ids: number[]) => {
    const next = clean(ids)
    if (!next.length) return
    window.history.pushState({ compareRead: true }, "", urlWith(next))
    setRaw(next)
  }
  const show = (ids: number[]) => {
    const next = clean(ids)
    if (!next.length) return
    window.history.replaceState(window.history.state, "", urlWith(next))
    setRaw(next)
  }
  const close = () => {
    if ((window.history.state as { compareRead?: boolean } | null)?.compareRead) window.history.back()
    else {
      window.history.replaceState(window.history.state, "", urlWith(null))
      setRaw(null)
    }
  }
  /** Forget the open recipes without a history step: the results they read are gone. */
  const reset = () => {
    if (readFrom(window.location.search) !== null) window.history.replaceState(null, "", urlWith(null))
    setRaw(null)
  }

  const ids = raw === null ? null : clean(raw)
  return { ids: ids && ids.length ? ids : null, open, show, close, reset }
}
