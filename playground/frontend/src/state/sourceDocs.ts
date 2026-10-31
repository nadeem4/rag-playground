/**
 * The documents a graph's source node holds. A pipeline runs on several: the
 * node keeps them all in `config.documents`, in order, and mirrors the first
 * into `config.sha` and `config.filename`, so a reader that wants one document
 * (a share link from an older version, a page that shows one) still finds it.
 * This module imports nothing, so the graph and the document state both read it.
 */

/** `category` is a pin: the category the document was put in (by a sort, or by hand). Absent means not pinned yet. */
export type DocRef = { sha: string; filename: string; category?: string }

type SourceConfig = Record<string, unknown> | undefined

const isDoc = (v: unknown): v is DocRef => {
  const d = v as DocRef | null
  return typeof d?.sha === "string" && d.sha !== "" && typeof d.filename === "string"
}

/** A document as the browser holds it: the category only when it is a pin. */
const refOf = (d: DocRef): DocRef => ({ sha: d.sha, filename: d.filename, ...(typeof d.category === "string" && d.category ? { category: d.category } : {}) })

/** The source node's documents, in order, each once. An older node with only `sha` and `filename` holds that one. */
export function docsOfSource(config: SourceConfig): DocRef[] {
  const list = config?.documents
  if (Array.isArray(list)) {
    const seen = new Set<string>()
    return list.filter(isDoc).flatMap((d) => (seen.has(d.sha) ? [] : (seen.add(d.sha), [refOf(d)])))
  }
  const sha = config?.sha
  return typeof sha === "string" && sha ? [{ sha, filename: String(config?.filename ?? "") }] : []
}

/**
 * A source node's settings on these documents: the first in `sha` and
 * `filename`, and with more than one, the whole list in `documents`. One
 * document keeps the node exactly as it always was, so a saved pipeline, a
 * share link and a result's staleness signature do not change.
 */
export function sourceConfigWith(config: SourceConfig, docs: readonly DocRef[]): Record<string, unknown> {
  const { documents: _list, sha: _sha, filename: _filename, ...rest } = config ?? {}
  if (!docs.length) return rest
  const first = { sha: docs[0].sha, filename: docs[0].filename }
  // A pin needs the list: `sha` and `filename` hold no category.
  return docs.length === 1 && !docs[0].category ? { ...rest, ...first } : { ...rest, ...first, documents: docs.map(refOf) }
}

/** The request field for pinned documents, `{categories: {sha: id}}`, or nothing when none is pinned. */
export function pinsOf(docs: readonly DocRef[]): { categories?: Record<string, string> } {
  const pins = docs.filter((d) => d.category).map((d) => [d.sha, d.category] as const)
  return pins.length ? { categories: Object.fromEntries(pins) as Record<string, string> } : {}
}
