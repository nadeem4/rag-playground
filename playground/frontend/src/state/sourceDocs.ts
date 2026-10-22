/**
 * The documents a graph's source node holds. A pipeline runs on several: the
 * node keeps them all in `config.documents`, in order, and mirrors the first
 * into `config.sha` and `config.filename`, so a reader that wants one document
 * (a share link from an older version, a page that shows one) still finds it.
 * This module imports nothing, so the graph and the document state both read it.
 */

export type DocRef = { sha: string; filename: string }

type SourceConfig = Record<string, unknown> | undefined

const isDoc = (v: unknown): v is DocRef => {
  const d = v as DocRef | null
  return typeof d?.sha === "string" && d.sha !== "" && typeof d.filename === "string"
}

/** The source node's documents, in order, each once. An older node with only `sha` and `filename` holds that one. */
export function docsOfSource(config: SourceConfig): DocRef[] {
  const list = config?.documents
  if (Array.isArray(list)) {
    const seen = new Set<string>()
    return list.filter(isDoc).flatMap((d) => (seen.has(d.sha) ? [] : (seen.add(d.sha), [{ sha: d.sha, filename: d.filename }])))
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
  return docs.length === 1 ? { ...rest, ...first } : { ...rest, ...first, documents: docs.map((d) => ({ sha: d.sha, filename: d.filename })) }
}
