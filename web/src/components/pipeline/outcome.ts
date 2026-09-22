import type { ArtifactType, ChunkSet, CleanReportEntry, ElementType, ParsedDoc, RetrievalResult, Stage } from "@/api/types"
import { chatStats, isChatOutput } from "@/components/inspectors/chat"
import { movement, rowsFromResult, type SearchOutput } from "@/components/inspectors/hits"
import type { IndexDescriptor } from "@/components/inspectors/IndexInspector"
import { median, overlapPairs, projectSpans } from "@/components/inspectors/spans"
import { fmt } from "@/components/inspectors/status"

/**
 * "What it did": one plain sentence per artifact, built from the payload with
 * the same numbers the inspectors show. The headline number is the one a
 * second run is compared against, "(was N)", so the sentence is kept in two
 * parts with the comparison slotted in after the headline.
 */

export interface Outcome {
  /** The number "(was N)" compares. */
  headline: number
  /** Text up to and including the headline number. */
  lead: string
  /** The rest of the sentence, starting with its punctuation. */
  tail: string
}

/** The sentence, with "(was N)" when the previous run's headline differs. */
export function outcomeText(o: Outcome, previous?: number | null): string {
  const was = previous !== undefined && previous !== null && previous !== o.headline ? ` (was ${fmt(previous)})` : ""
  return `${o.lead}${was}${o.tail}`
}

const PLURAL: Partial<Record<ElementType, [string, string]>> = {
  heading: ["heading", "headings"],
  paragraph: ["paragraph", "paragraphs"],
  table: ["table", "tables"],
  list_item: ["list item", "list items"],
  figure: ["figure", "figures"],
  caption: ["caption", "captions"],
  code: ["code block", "code blocks"],
  header: ["page header", "page headers"],
  footer: ["page footer", "page footers"],
  footnote: ["footnote", "footnotes"],
  formula: ["formula", "formulas"],
  page_number: ["page number", "page numbers"],
}

function count(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`
}

/** "30 paragraphs, 6 headings and 2 others", largest group first. */
function byType(types: readonly string[], shown = 4): string {
  const tally = new Map<string, number>()
  for (const t of types) tally.set(t, (tally.get(t) ?? 0) + 1)
  const groups = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const parts = groups.slice(0, shown).map(([t, n]) => {
    const [one, many] = PLURAL[t as ElementType] ?? [t.replace(/_/g, " "), `${t.replace(/_/g, " ")}s`]
    return count(n, one, many)
  })
  const rest = groups.slice(shown).reduce((s, [, n]) => s + n, 0)
  if (rest) parts.push(count(rest, "other", "others"))
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "")
}

function parsedOutcome(doc: ParsedDoc): Outcome {
  const n = doc.elements.length
  const kinds = byType(doc.elements.map((e) => e.type))
  return {
    headline: n,
    lead: `Found ${count(n, "element", "elements")}`,
    tail: ` on ${count(doc.page_count, "page", "pages")}${kinds ? `: ${kinds}` : ""}.`,
  }
}

function cleanOutcome(entry: CleanReportEntry): Outcome {
  const n = entry.removed.length
  const kinds = byType(entry.removed.map((r) => r.type))
  return {
    headline: n,
    lead: `Removed ${count(n, "element", "elements")}`,
    tail: `, kept ${fmt(entry.kept_count)}${kinds ? `. Removed ${kinds}` : ""}.`,
  }
}

function chunkOutcome(set: ChunkSet): Outcome {
  const tokens = set.chunks.map((c) => c.token_count)
  const n = set.chunks.length
  if (n === 0) return { headline: 0, lead: "Made 0 chunks", tail: ". The document produced no text to cut." }
  // The same projection the chunk inspector counts overlaps with.
  const overlaps = overlapPairs(projectSpans(set.source_text, set.chunks)).length
  return {
    headline: n,
    lead: `Made ${count(n, "chunk", "chunks")}`,
    tail: `. Median ${fmt(median(tokens) ?? 0)} tokens, largest ${fmt(Math.max(...tokens))}. ${count(overlaps, "overlap", "overlaps")}.`,
  }
}

function indexOutcome(d: IndexDescriptor): Outcome | null {
  if (typeof d.doc_count !== "number") return null
  const parts: string[] = []
  if (typeof d.embeddings_computed === "number" || typeof d.embeddings_cached === "number") {
    parts.push(`${fmt(d.embeddings_computed ?? 0)} embedded, ${fmt(d.embeddings_cached ?? 0)} from cache`)
  }
  if (typeof d.dim === "number") {
    const truncated = typeof d.native_dim === "number" && d.dim < d.native_dim
    parts.push(truncated ? `${fmt(d.dim)} of ${fmt(d.native_dim!)} dimensions` : `${fmt(d.dim)} dimensions`)
  }
  return {
    headline: d.doc_count,
    lead: `Indexed ${count(d.doc_count, "chunk", "chunks")}`,
    tail: parts.length ? `: ${parts.join(". ")}.` : ".",
  }
}

function retrievalOutcome(r: RetrievalResult, stage: Stage): Outcome {
  const rows = rowsFromResult(r)
  if (stage === "rerank") {
    const moved = rows.filter((row) => movement(row).kind !== "none").length
    return {
      headline: moved,
      lead: `Moved ${fmt(moved)}`,
      tail: ` of ${count(rows.length, "hit", "hits")}${moved === 0 ? ". The order did not change" : ""}.`,
    }
  }
  return {
    headline: rows.length,
    lead: `Returned ${count(rows.length, "hit", "hits")}`,
    tail: ` from ${count(r.total_candidates, "candidate", "candidates")}.`,
  }
}

function outputOutcome(data: unknown): Outcome | null {
  if (isChatOutput(data)) {
    const s = chatStats(data.payload)
    const check = s.citations === 0 ? "" : s.unverified === 0 ? ", all verified" : `, ${fmt(s.unverified)} not verified`
    return { headline: s.citations, lead: `Answered with ${count(s.citations, "citation", "citations")}`, tail: `${check}.` }
  }
  const out = data as SearchOutput
  if (out?.kind === "search" && Array.isArray(out.payload?.results)) {
    const n = out.payload.results.length
    const total = out.payload.total_candidates
    return {
      headline: n,
      lead: `Listed ${count(n, "result", "results")}`,
      tail: typeof total === "number" ? ` from ${count(total, "candidate", "candidates")}.` : ".",
    }
  }
  return null
}

const isObj = (d: unknown): d is Record<string, unknown> => typeof d === "object" && d !== null && !Array.isArray(d)

/** The outcome of one artifact, or null for a type with nothing to say (a raw file, a query). */
export function outcomeFor(stage: Stage, type: ArtifactType | undefined, data: unknown): Outcome | null {
  if (!isObj(data)) return null
  switch (type) {
    case "parsed_doc": {
      const doc = data as unknown as ParsedDoc
      if (!Array.isArray(doc.elements)) return null
      const report = doc.parser_meta?.clean_report
      if (stage === "clean" && Array.isArray(report) && report.length) return cleanOutcome(report[report.length - 1])
      return parsedOutcome(doc)
    }
    case "chunk_set":
      return Array.isArray(data.chunks) ? chunkOutcome(data as unknown as ChunkSet) : null
    case "index":
      return indexOutcome(data as IndexDescriptor)
    case "retrieval_result":
      return Array.isArray(data.hits) ? retrievalOutcome(data as unknown as RetrievalResult, stage) : null
    case "output":
      return outputOutcome(data)
    default:
      return null
  }
}
