import recorded from "./e2e-run.json"

/**
 * The end-to-end lesson's words, computed from a recorded real run
 * (`scripts/record_e2e_lesson.py` writes `e2e-run.json`). Every number the
 * lesson shows comes from here, never from a hand-typed string.
 */

export interface E2EChunk {
  id: string
  ordinal: number
  start: number
  end: number
  page_span: number[]
  text: string
}

export interface PoolEntry {
  id: string
  rank: number
  score: number
  dense: number | null
  bm25: number | null
}

export interface E2ERun {
  question: string
  filename: string
  page_count: number
  chunks: E2EChunk[]
  pool: PoolEntry[]
  mmr: string[]
  elements: { type: string; page: number; text: string }[]
  removed: { type: string; page: number; text: string; duplicate_of_page: number | null; reason: string }[]
  index: { model: string; dim: number; doc_count: number }
  chunker: { chunker: string; chunk_size: number; chunk_overlap: number }
}

export const RUN = recorded as E2ERun

export interface StepWords {
  title: string
  words: string[]
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

/** Small counts read better as words. */
export const numberWord = (n: number) => WORDS[n] ?? String(n)

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A chunk's text without its markdown headings, cut at a word. */
export function snippet(text: string, n = 90): string {
  const s = text
    .replace(/^## .*(\n\n|$)/, "")
    .replace(/\n\n## .*$/, "")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > n ? `${s.slice(0, n).replace(/\s\S*$/, "")}...` : s
}

export const chunkById = (run: E2ERun, id: string) => run.chunks.find((c) => c.id === id)!
const poolEntry = (run: E2ERun, id: string) => run.pool.find((p) => p.id === id)!
const len = (c: E2EChunk) => c.end - c.start

export interface Hit {
  id: string
  text: string
  pages: number[]
  rank: number
}

/** What search returned: the reranker's picks, in its order. */
export function searchHits(run: E2ERun): Hit[] {
  return run.mmr.map((id) => {
    const c = chunkById(run, id)
    return { id, text: c.text, pages: c.page_span, rank: poolEntry(run, id).rank }
  })
}

const pagesText = (p: number[]) => (p[0] === p[p.length - 1] ? `page ${p[0]}` : `pages ${p[0]} to ${p[p.length - 1]}`)

export const hitMeta = (h: Hit, run: E2ERun) => `${pagesText(h.pages)}, ranked ${h.rank} of ${run.pool.length} by the retriever`

/** Rerank: which ranks it passed over, and the deepest rank it reached down to. */
export function rerankStep(run: E2ERun): StepWords & { skipped: PoolEntry[]; reached: PoolEntry | null } {
  const kept = run.pool.filter((p) => run.mmr.includes(p.id))
  const deepest = kept.reduce((a, b) => (b.rank > a.rank ? b : a))
  const skipped = run.pool.filter((p) => !run.mmr.includes(p.id) && p.rank < deepest.rank)
  const count = numberWord(run.mmr.length)
  const words = [`The retriever ranked all ${run.pool.length} chunks.`]
  if (skipped.length === 0) {
    words.push(`The reranker kept the top ${count} in order, because they were already different enough from each other.`)
    return { title: `Rerank kept the top ${count}`, words, skipped, reached: null }
  }
  words.push(
    `The reranker then chose ${count} that are relevant but different from each other.`,
    `It passed over ${listJoin(skipped.map((p) => `#${p.rank}`))}, which are close in meaning to chunks it had already picked, and reached down to #${deepest.rank} instead because it adds a different point.`,
  )
  return { title: `Rerank picked a varied ${count}`, words, skipped, reached: deepest }
}

export interface RerankRow {
  rank: number
  text: string
  kind: "kept" | "skipped" | "rest"
  why: string
}

/** The candidate list, down to the deepest pick unless `all`. */
export function rerankRows(run: E2ERun, all: boolean): RerankRow[] {
  const { skipped, reached } = rerankStep(run)
  const limit = reached?.rank ?? run.mmr.length
  return run.pool
    .filter((p) => all || p.rank <= limit)
    .map((p) => {
      const kept = run.mmr.includes(p.id)
      const passed = skipped.includes(p)
      return {
        rank: p.rank,
        text: snippet(chunkById(run, p.id).text, 80),
        kind: kept ? "kept" : passed ? "skipped" : "rest",
        why: kept ? (p.id === reached?.id ? "picked for variety" : "picked") : passed ? "passed over, too similar" : "",
      }
    })
}

/** The top `k` by one search's own score. */
export function topBy(run: E2ERun, key: "dense" | "bm25", k: number): PoolEntry[] {
  return [...run.pool]
    .filter((p) => p[key] !== null)
    .sort((a, b) => b[key]! - a[key]!)
    .slice(0, k)
}

export function retrieveStep(run: E2ERun): StepWords {
  const dense = topBy(run, "dense", 1)[0]
  const bm25 = topBy(run, "bm25", 1)[0]
  const agree = dense && bm25 && dense.id === bm25.id
  return {
    title: "Retrieve searched in two ways",
    words: [
      "Hybrid search ran a keyword search and a meaning search, then merged the two rankings.",
      agree
        ? "The top chunk came first in both lists. It shares the most words with the question, and it is also the closest in meaning."
        : "The two searches put different chunks first, and the merge decided between them.",
      `For the meaning search, the index had turned each of the ${run.index.doc_count} chunks into a list of ${run.index.dim} numbers with ${run.index.model}.`,
    ],
  }
}

export function chunkStep(run: E2ERun): StepWords {
  const top = chunkById(run, run.mmr[0])
  const words = [
    `The recursive chunker cut at paragraph and sentence breaks, into chunks of up to ${run.chunker.chunk_size} characters with ${run.chunker.chunk_overlap} characters of overlap.`,
  ]
  if (top.text.startsWith("## ")) words.push("The top chunk holds a heading and the paragraph under it.")
  return { title: `Chunk cut the document into ${run.chunks.length} pieces`, words }
}

export function cleanStep(run: E2ERun): StepWords {
  const r = run.removed[0]
  return {
    title: "Clean removed a repeated paragraph",
    words: [
      `The same paragraph appears on page ${r.duplicate_of_page} and again on page ${r.page}.`,
      "The duplicate cleaner kept the first copy and removed the second, so the search does not return the same text twice.",
    ],
  }
}

export function parseStep(run: E2ERun): StepWords {
  const counts = new Map<string, number>()
  for (const e of run.elements) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  const kinds = [...counts].map(([t, n]) => plural(n, t.replace(/_/g, " ")))
  return {
    title: "Parse read the PDF",
    words: [
      `Docling read ${plural(run.page_count, "page")} and found ${run.elements.length} blocks of text: ${listJoin(kinds)}.`,
      "It also recognised the page numbers and the footer on each page, and left them out.",
    ],
  }
}

/** Where a quoted sentence lives: its chunk number (from 1) and first page. */
export function quoteSource(run: E2ERun, sentence: string): { chunk: number; page: number } | null {
  const c = run.chunks.find((x) => x.text.includes(sentence))
  return c ? { chunk: c.ordinal + 1, page: c.page_span[0] } : null
}

/** A chunk-map bar's height: `min` plus `span` scaled by length against the longest chunk. */
export function barHeight(c: E2EChunk, run: E2ERun, min: number, span: number): number {
  const longest = Math.max(...run.chunks.map(len))
  return Math.round(min + (span * len(c)) / longest)
}

export const previewCaption = (run: E2ERun) =>
  `The sample cut into ${run.chunks.length} chunks, and the ${numberWord(run.mmr.length)} that answered the question.`
