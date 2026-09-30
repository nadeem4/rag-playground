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
  /** The parse step's wall-clock time, to one decimal. */
  seconds: number
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
}

export const LAB: Lab = recorded as Lab

export const SITUATION: Record<string, string> = {
  "two-column-report":
    "Journals, annual reports and white papers are set in two columns. A plain text extractor reads across the page, so it can join the halves of two different sentences.",
  "table-of-figures": "Invoices, lab reports and study results put the numbers in a table. A parser that does not see the table turns rows into loose words.",
  "scanned-notes": "Archives, faxes and phone photos have no text layer. Without OCR there is nothing to read.",
}

/** Seconds per page, to one decimal. */
export function perPage(run: ParserRun, pages: number): number {
  return Math.round((run.seconds / Math.max(pages, 1)) * 10) / 10
}

/**
 * A recorded time of 0 means under 0.05 seconds (times are rounded to one
 * decimal), so 0.05 stands in for it rather than dividing by zero.
 */
const atLeast = (seconds: number) => Math.max(seconds, 0.05)

/** How many times longer Layout took than Fast text, as a whole number, at least 1. */
export function ratio(c: LabCase): number {
  return Math.max(1, Math.round(c.parsers.docling.seconds / atLeast(c.parsers.pdfium.seconds)))
}

/** The same ratio over several cases together: all of Layout's time over all of Fast text's. */
export function layoutRatio(cases: LabCase[]): number {
  const sum = (p: ParserId) => cases.reduce((s, c) => s + c.parsers[p].seconds, 0)
  return Math.max(1, Math.round(sum("docling") / atLeast(sum("pdfium"))))
}

const other = (p: ParserId): ParserId => (p === "pdfium" ? "docling" : "pdfium")

export function verdict(c: LabCase, pick: ParserId): string {
  const mine = c.parsers[pick].hits
  const theirs = c.parsers[other(pick)].hits
  if (mine === theirs) return `Both answered ${mine} of ${c.questions}, so the fast one wins on cost.`
  return (
    `You picked ${PARSER_LABEL[pick]}. Here it answered ${mine} of ${c.questions} and ${PARSER_LABEL[other(pick)]} answered ${theirs} of ${c.questions}. ` +
    `The cost: Layout took ${ratio(c)} times longer per page.`
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
    if (parser === "docling" && c.name === "scanned-notes") {
      const node = g.nodes.find((n) => n.id === parse.id)!
      g = setConfig(g, parse.id, { ...node.config, do_ocr: true })
    }
  }
  return `/build?pipeline=${encodePipeline(`Parsing lab: ${c.title}, ${PARSER_LABEL[parser]}`, g)}`
}

const DIGITAL = LAB.cases.filter((c) => c.name !== "scanned-notes")
const SCAN = LAB.cases.find((c) => c.name === "scanned-notes")

export const RULES: string[] = [
  "Digital-born, one column, mostly prose: Fast text. It is the cheapest and it loses little.",
  `Columns or tables: Layout. It costs ${layoutRatio(DIGITAL)} times more per page here, and it is the difference between finding the answer and not.`,
  `Scans: Layout with OCR, and budget for it. On this sample OCR cost ${SCAN ? perPage(SCAN.parsers.docling, SCAN.pages) : 0} seconds per page.`,
]

export const CLOSING = "These numbers were measured on one machine. Yours will differ. The ratios are what to carry with you."

export const RECAP: string[] = [
  "You can tell from the PDF's shape which parser will pay for itself.",
  "A layout parser costs many times more per page and finds what a text extractor cannot.",
  "OCR is a separate cost on top, and the only way in for a scan.",
]
