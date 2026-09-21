import { useEffect, useState } from "react"

import { api } from "./client"
import type { FindResult, PdfPageSize } from "./types"

/**
 * Page sizes and text search for an uploaded PDF (plan I-9). A source is
 * content-addressed, so both are kept for the session; a failure is not.
 */

const pagesCache = new Map<string, Promise<PdfPageSize[]>>()
const findCache = new Map<string, Promise<FindResult>>()

function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key)
  if (!p) {
    p = load()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

export type Loaded<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; message: string }

function useLoad<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; value: Loaded<T> }>({ key: null, value: { kind: "loading" } })
  useEffect(() => {
    if (key === null) return
    let live = true
    load().then(
      (data) => live && setState({ key, value: { kind: "ready", data } }),
      (err: unknown) => live && setState({ key, value: { kind: "error", message: err instanceof Error ? err.message : String(err) } }),
    )
    return () => {
      live = false
    }
    // `load` is derived from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state.key === key ? state.value : { kind: "loading" }
}

export function usePageSizes(sha: string): Loaded<PdfPageSize[]> {
  return useLoad(sha, () => once(pagesCache, sha, () => api.pages(sha)))
}

/** `text` null skips the search. */
export function useFind(sha: string, page: number | null, text: string | null): Loaded<FindResult> {
  const key = page === null || text === null ? null : JSON.stringify([sha, page, text])
  return useLoad(key, () => once(findCache, key!, () => api.findOnPage(sha, page!, text!)))
}

/** Tests only. */
export function clearPdfCaches(): void {
  pagesCache.clear()
  findCache.clear()
}
