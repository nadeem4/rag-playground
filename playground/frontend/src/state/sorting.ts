import { useEffect, useMemo, useState } from "react"

import { v2 } from "@/api/v2"

import type { PipelineConfig } from "./config"
import { pinsOf, type DocRef } from "./sourceDocs"

/** What each document's category is and why, by sha. */
export type Sorted = Record<string, { category: string; reason: string }>

/** The reason a pinned document gives. */
export const CHOSEN = "Chosen when added"

/** `Reports with tables, by rule 2`: the category name and how the document got there. */
export function lineOf(name: string, reason: string): string {
  const rule = /^Rule (\d+):/.exec(reason)
  if (rule) return `${name}, by rule ${rule[1]}`
  if (reason.startsWith("Default")) return `${name}, by default`
  return `${name}, chosen by hand`
}

/**
 * Which category each document is in. A pinned document keeps its pin; the
 * others are sorted by the routes (nothing runs). A config with one plain
 * category has nothing to sort.
 */
export function useSorting(config: PipelineConfig, docs: readonly DocRef[]): Sorted {
  const pins = pinsOf(docs).categories ?? {}
  const open = docs.filter((d) => !pins[d.sha]).map((d) => d.sha)
  const sorts = Boolean(config.categories)
  const key = JSON.stringify([config.route, config.categories ? Object.keys(config.categories) : null, open])
  const [got, setGot] = useState<{ key: string; sorted: Sorted }>({ key: "", sorted: {} })
  useEffect(() => {
    if (!sorts || !open.length) return
    const ctl = new AbortController()
    v2.sortDocuments(config, open, pins, ctl.signal)
      .then((r) => setGot({ key, sorted: r.documents }))
      .catch(() => {})
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the routes and the unpinned documents
  }, [key])
  return useMemo(() => {
    if (!sorts) return {}
    const out: Sorted = {}
    for (const d of docs) {
      if (pins[d.sha]) out[d.sha] = { category: pins[d.sha], reason: CHOSEN }
      else if (got.key === key && got.sorted[d.sha]) out[d.sha] = got.sorted[d.sha]
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pins` is read from `docs`
  }, [docs, sorts, got, key])
}

/** The documents with the first sort written into each one's pin, so a change to the routes never reshuffles them. The same list when nothing is new. */
export function pinSorted(docs: DocRef[], sorted: Sorted): DocRef[] {
  if (!docs.some((d) => !d.category && sorted[d.sha])) return docs
  return docs.map((d) => (d.category || !sorted[d.sha] ? d : { ...d, category: sorted[d.sha].category }))
}
