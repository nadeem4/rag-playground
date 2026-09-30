import type { Registry } from "@/api/types"
import { sampleGraph, setConfig, setTransform } from "@/state/graph"
import { encodePipeline } from "@/state/pipelines"

import recorded from "./parsing-lab.json"

/**
 * Learn > Choosing a parser: the words and numbers, computed from a recorded
 * real run (`scripts/record_parsing_lab.py` writes `parsing-lab.json`). Every
 * number the lesson shows comes from here, never from a hand-typed string.
 */

export type ParserId = "pdfium" | "docling"

export const PARSERS: ParserId[] = ["pdfium", "docling"]

export const PARSER_LABEL: Record<ParserId, string> = { pdfium: "Fast text", docling: "Layout" }

export interface ParserRun {
  /** The parse step's wall-clock time, in whole milliseconds. */
  ms: number
  /** Characters of text the parser kept. */
  chars: number
  /** Questions whose answer was in the top k. */
  hits: number
  ocr: boolean
  /** Up to 160 characters around the first answer, or null when its words do not appear together. */
  excerpt: string | null
}

export interface LabCase {
  name: string
  title: string
  sha: string
  filename: string
  pages: number
  questions: number
  question: string
  parsers: Record<ParserId, ParserRun>
}

export interface Lab {
  recorded_on: string
  chunker: Record<string, unknown>
  top_k: number
  cases: LabCase[]
  /** The chunking primer, recorded the same way: one column of prose, the point of comparison. */
  baseline: LabCase
}

export const LAB: Lab = recorded as Lab

export const INTRO =
  "Fast text (pdfium) copies the PDF's text layer in reading order. Layout (Docling) looks at the page to find columns and tables, and can run OCR."

export const BASELINE_LABEL = "A primer on chunking (one column of prose)"

const tie = (c: LabCase) => c.parsers.pdfium.hits === c.parsers.docling.hits

/** The table case's situation depends on whether Fast text kept up with Layout. */
export function situation(table: LabCase): string {
  return tie(table)
    ? "Invoices, lab reports and study results put the numbers in a table. A text extractor keeps a simple ruled table's rows in reading order, but drops the ruling, so a chunk cutter cannot see where the table starts and ends. A layout parser keeps the table as a table."
    : "Invoices, lab reports and study results put the numbers in a table. A parser that does not see the table turns rows into loose words."
}

const byName = (name: string) => LAB.cases.find((c) => c.name === name)!
const COLUMNS = byName("two-column-report")
const TABLE = byName("table-of-figures")
const SCAN = byName("scanned-notes")

export const SITUATION: Record<string, string> = {
  "two-column-report":
    "Journals, annual reports and white papers are set in two columns. A plain text extractor reads across the page, so it can join the halves of two different sentences.",
  "table-of-figures": situation(TABLE),
  "scanned-notes": "Archives, faxes and phone photos have no text layer. Without OCR there is nothing to read.",
}

/** Seconds per page, to one decimal. */
export function perPage(run: ParserRun, pages: number): number {
  return Math.round((run.ms / 1000 / Math.max(pages, 1)) * 10) / 10
}

/** Seconds per page as the tables show it: "under 0.1" when it rounds below a tenth. */
export function secondsPerPage(run: ParserRun, pages: number): string {
  const n = perPage(run, pages)
  return n < 0.1 ? "under 0.1" : String(n)
}

/** How many times longer Layout took than Fast text, from the raw milliseconds, as a whole number, at least 1. */
export function ratio(c: LabCase): number {
  return Math.max(1, Math.round(c.parsers.docling.ms / Math.max(c.parsers.pdfium.ms, 1)))
}

const other = (p: ParserId): ParserId => (p === "pdfium" ? "docling" : "pdfium")

export function verdict(c: LabCase, pick: ParserId): string {
  const mine = c.parsers[pick].hits
  const theirs = c.parsers[other(pick)].hits
  if (mine === theirs) return `Both answered ${mine} of ${c.questions}, so the fast one wins on cost.`
  return (
    `You picked ${PARSER_LABEL[pick]}. Here it answered ${mine} of ${c.questions} and ${PARSER_LABEL[other(pick)]} answered ${theirs} of ${c.questions}. ` +
    (pick === "docling" ? `The cost: Layout took ${ratio(c)} times longer per page.` : `Layout would have taken ${ratio(c)} times longer per page.`)
  )
}

/** Why a parser has no excerpt: it read something, but not the answer's words together, or it read nothing. */
export function missingExcerpt(run: ParserRun): string {
  return run.chars > 0 ? "The answer's words do not appear together in this text." : "Nothing was read."
}

/** A share link that opens Build on the case's sample with this parser, ready to run. */
export function runLink(registry: Registry, c: LabCase, parser: ParserId): string {
  let g = sampleGraph(registry, { sha: c.sha, filename: c.filename }, c.question)
  const parse = g.nodes.find((n) => n.stage === "parse")
  if (parse) {
    g = setTransform(g, parse.id, parser, registry)
    if (c.parsers[parser].ocr) {
      const node = g.nodes.find((n) => n.id === parse.id)!
      g = setConfig(g, parse.id, { ...node.config, do_ocr: true })
    }
  }
  return `/build?pipeline=${encodePipeline(`Parsing lab: ${c.title}, ${PARSER_LABEL[parser]}`, g)}`
}

/** The four rules of step 4, from the baseline, the table, the columns and the scan. */
export function rules(b: LabCase, t: LabCase, c: LabCase, s: LabCase): string[] {
  return [
    tie(b)
      ? `Digital-born, one column, mostly prose: Fast text. On the primer it answered ${b.parsers.pdfium.hits} of ${b.questions}, the same as Layout, at a fraction of the cost.`
      : `Digital-born, one column, mostly prose: Fast text. On the primer it answered ${b.parsers.pdfium.hits} of ${b.questions} against Layout's ${b.parsers.docling.hits}, at a fraction of the cost.`,
    `Columns: Layout. It costs ${ratio(c)} times more per page here, and it is the difference between finding the answer and not.`,
    tie(t)
      ? `Simple ruled tables: Fast text keeps the rows in reading order and answered ${t.parsers.pdfium.hits} of ${t.questions}, the same as Layout. Layout keeps the table as a table, which starts to matter when tables are wide or a chunk cutter needs their edges.`
      : `Tables: Layout. Fast text answered ${t.parsers.pdfium.hits} of ${t.questions} here and Layout answered ${t.parsers.docling.hits}.`,
    `Scans: Layout with OCR, and budget for it. On this sample Layout with OCR took ${perPage(s.parsers.docling, s.pages)} seconds per page.`,
  ]
}

export const RULES: string[] = rules(LAB.baseline, TABLE, COLUMNS, SCAN)

/** The two-column case: the document beside step 4 and the recap. */
export const FEATURED: LabCase = COLUMNS

export const CLOSING = "These numbers were measured on one machine. Yours will differ. The ratios are what to carry with you."

export const RECAP: string[] = [
  "You can tell from the PDF's shape which parser will pay for itself.",
  "A layout parser costs many times more per page and finds what a text extractor cannot.",
  "OCR is a separate cost on top of Layout, and the only way in for a scan.",
]
