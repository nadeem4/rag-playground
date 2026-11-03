import type { ServeExportRequest, ServeWhere } from "@/api/types"

import { usedBy } from "./categories"
import { categoriesOf, type PipelineConfig } from "./config"
import type { Question } from "./goldSet"
import type { Sorted } from "./sorting"
import type { DocRef } from "./sourceDocs"

/**
 * The Take it home page's numbers and request, kept pure so the rules are
 * testable without a browser: which categories have a check worth trusting,
 * and what the serve export sends.
 */

/** Questions a category needs of the team's own before its check counts as ready. */
export const READY_AT = 10

export type RowStatus = "ready" | "weak" | "sample-only" | "not-tested"

export interface Row {
  id: string
  name: string
  /** The filenames of the documents in this category. */
  documents: string[]
  /** The questions that name one of those documents. */
  count: number
  /** The last Evaluate result for these documents, as a line; null when there is none. */
  lastScore: string | null
  status: RowStatus
  /** The questions are a sample's own, so the export leaves them out. */
  sample: boolean
  /** The questions the export would send for this category. */
  questions: Question[]
  /** The documents' fingerprints, to open Evaluate or Build on one of them. */
  shas: string[]
}

export interface RowOptions {
  /** The questions are the bundled samples' own. */
  fromSamples?: boolean
  /** The last Evaluate result for these documents (their shas joined with commas), or null. */
  scoreFor?: (docsKey: string) => string | null
}

export function categoryRows(
  config: PipelineConfig,
  docs: readonly DocRef[],
  sorted: Sorted,
  questions: readonly Question[],
  options: RowOptions = {},
): Row[] {
  return Object.entries(categoriesOf(config)).map(([id, def]) => {
    const own = usedBy(docs, sorted, id)
    const shas = own.map((d) => d.sha)
    const mine = questions.filter((q) => q.document && shas.includes(q.document))
    const sample = Boolean(options.fromSamples) && own.length > 0
    const status: RowStatus = own.length === 0 ? "not-tested" : sample && mine.length > 0 ? "sample-only" : mine.length >= READY_AT ? "ready" : "weak"
    return {
      id,
      name: def.name ?? id,
      documents: own.map((d) => d.filename),
      count: mine.length,
      lastScore: own.length ? (options.scoreFor?.(shas.join(",")) ?? null) : null,
      status,
      sample,
      questions: mine,
      shas,
    }
  })
}

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

/** The serve export request. A question names its document by filename, as the project's docs/ folder does. */
export function exportBody(config: unknown, name: string, rows: readonly Row[], where: ServeWhere): ServeExportRequest {
  const categories: ServeExportRequest["categories"] = {}
  for (const r of rows) {
    if (!r.documents.length) continue
    const filenameOf = new Map(r.shas.map((sha, i) => [sha, r.documents[i]]))
    categories[r.id] = {
      sample: r.sample,
      questions: r.sample
        ? []
        : r.questions.map((q) => ({
            id: q.id,
            question: q.question,
            gold_answers: q.gold_answers,
            tags: q.tags,
            answer: q.answer,
            document: filenameOf.get(q.document ?? "") ?? "",
          })),
    }
  }
  return { config, name, categories, where }
}
