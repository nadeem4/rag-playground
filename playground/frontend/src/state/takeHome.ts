import type { ServeExportRequest, ServeWhere } from "@/api/types"

import { usedBy } from "./categories"
import { categoriesOf, type PipelineConfig } from "./config"
import type { Question } from "./goldSet"
import type { Sorted } from "./sorting"
import type { DocRef } from "./sourceDocs"

/**
 * The Take it home page's numbers and request, kept pure so the rules are
 * testable without a browser: which categories have a check worth trusting,
 * and what the exports send.
 */

/** Questions a category needs of the team's own before its check counts as ready. */
export const READY_AT = 10

export type RowStatus = "ready" | "weak" | "sample-only" | "not-tested"

export interface DocLine {
  filename: string
  tag: "Your upload" | "Sample"
}

export interface RowAction {
  kind: "write" | "add" | "test"
  label: string
}

export interface Row {
  id: string
  name: string
  /** The filenames of the documents in this category. */
  documents: string[]
  /** The same documents with the tag the page shows beside each. */
  docs: DocLine[]
  /** The questions that name one of those documents. */
  count: number
  status: RowStatus
  /** The mark shown beside the status word, so colour is never the only signal. */
  mark: string
  /** What the status means for this category, in a sentence. */
  text: string
  /** What to do about it; null when the check is ready. */
  action: RowAction | null
  /** The questions come only from sample documents, so the export leaves them out. */
  sample: boolean
  /** The questions the export would send for this category. */
  questions: Question[]
  /** The documents' fingerprints, to open Evaluate or Build on one of them. */
  shas: string[]
}

export interface RowOptions {
  /** The fingerprints of the bundled samples among the documents. */
  sampleShas?: readonly string[]
}

const MARK: Record<RowStatus, string> = { ready: "✓", weak: "!", "sample-only": "!", "not-tested": "-" }

/** "Scanned forms" as one document of that kind: "scanned form". */
function oneOf(name: string): string {
  const w = name.toLowerCase()
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`
  return w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function describe(status: RowStatus, name: string, count: number): { text: string; action: RowAction | null } {
  const kind = oneOf(name)
  if (status === "ready") return { text: "Enough of your own questions for the quality check to catch a problem.", action: null }
  if (status === "weak")
    return {
      text: `${count ? `Only ${plural(count, "question")}.` : "No questions of your own yet."} With so few, one bad change can slip through. Aim for ${READY_AT} or more.`,
      action: { kind: "write", label: count ? `Write ${READY_AT - count} more questions` : `Write ${READY_AT} questions` },
    }
  if (status === "sample-only")
    return {
      text: `These ${count} questions are about our sample, not your documents, so they stay out of the download. Add a ${kind} document of your own and write questions on it.`,
      action: { kind: "add", label: `Add a ${kind} document` },
    }
  return {
    text: `Documents in ${name} will still be read and indexed, but nothing checks how well. Try one ${kind} on Build first.`,
    action: { kind: "test", label: `Test a ${kind} on Build` },
  }
}

export function categoryRows(
  config: PipelineConfig,
  docs: readonly DocRef[],
  sorted: Sorted,
  questions: readonly Question[],
  options: RowOptions = {},
): Row[] {
  const samples = new Set(options.sampleShas ?? [])
  return Object.entries(categoriesOf(config)).map(([id, def]) => {
    // A config with one plain category has nothing to sort: every document is in it.
    const own = config.categories ? usedBy(docs, sorted, id) : [...docs]
    const shas = own.map((d) => d.sha)
    const mine = questions.filter((q) => q.document && shas.includes(q.document))
    // Sample only when every question comes from a bundled sample document.
    const sample = own.length > 0 && mine.length > 0 && mine.every((q) => samples.has(q.document ?? ""))
    const status: RowStatus = own.length === 0 ? "not-tested" : sample ? "sample-only" : mine.length >= READY_AT ? "ready" : "weak"
    const name = def.name ?? id
    return {
      id,
      name,
      documents: own.map((d) => d.filename),
      docs: own.map((d) => ({ filename: d.filename, tag: samples.has(d.sha) ? "Sample" : "Your upload" })),
      count: mine.length,
      status,
      mark: MARK[status],
      ...describe(status, name, mine.length),
      sample,
      questions: mine,
      shas,
    }
  })
}

/** A one-document pipeline's own set: its questions all belong to that document, whether or not they say so. */
export const forDocument = (questions: readonly Question[], sha: string): Question[] => questions.map((q) => ({ ...q, document: sha }))

/** How many questions name no document. They are never exported. */
export const unnamedCount = (questions: readonly Pick<Question, "document">[]): number => questions.filter((q) => !q.document).length

/** The categories that are ready, and the questions the export will carry (samples left out). */
export function summary(rows: readonly Row[]): { ready: number; questions: number } {
  return {
    ready: rows.filter((r) => r.status === "ready").length,
    questions: rows.filter((r) => !r.sample).reduce((n, r) => n + r.count, 0),
  }
}

export const defaultWhere = (): ServeWhere => ({ source: "./docs", index_store: "lancedb", index_url: "./index" })

type Sent = ServeExportRequest["categories"][string]["questions"]

/** A row's questions as the exports send them: a question names its document by filename, as the project's docs/ folder does. */
function sent(r: Row): Sent {
  const filenameOf = new Map(r.shas.map((sha, i) => [sha, r.documents[i]]))
  return r.questions.map((q) => ({
    id: q.id,
    question: q.question,
    gold_answers: q.gold_answers,
    tags: q.tags,
    answer: q.answer,
    document: filenameOf.get(q.document ?? "") ?? "",
  }))
}

/** The serve export request. The config goes as it is: a plain pipeline's one category is `default`. */
export function exportBody(config: PipelineConfig, name: string, rows: readonly Row[], where: ServeWhere): ServeExportRequest {
  const categories: ServeExportRequest["categories"] = {}
  for (const r of rows) {
    if (!r.documents.length) continue
    categories[r.id] = { sample: r.sample, questions: r.sample ? [] : sent(r) }
  }
  return { config, name, categories, where }
}

/** The laptop project's question set: every category's own questions in one set. Undefined when there are none. */
export function laptopQuestions(rows: readonly Row[]): { version: 1; questions: Sent } | undefined {
  const questions = rows.flatMap((r) => (r.sample ? [] : sent(r)))
  return questions.length ? { version: 1, questions } : undefined
}
