import type { Registry } from "@/api/types"

import { columnOf, removedText, servedConfig, unknownStrategy, type AskQuestion, type PipelineConfig, type Step } from "./config"
import type { DocRef } from "./document"
import type { PipelineGraph } from "./graph"

/**
 * The pipeline templates of `GET /api/templates` (`pandion.list_templates`), and
 * how Build turns an index template and a query template into its
 * working pipeline. The composed config is the pipeline file's shape, which is
 * what Build already holds, so no server call is needed to compose it: the
 * index template sets `index`, the query template `retrieve` and `answer`.
 */

interface TemplateBase {
  id: string
  name: string
  summary: string
  good_for: string
}

export interface IndexTemplate extends TemplateBase {
  sample: string
  pipeline: { index: PipelineConfig["index"] }
}

/** `rewrite` is "none" or a step, as in a Pandion pipeline file. */
type TemplateRetrieve = Omit<NonNullable<PipelineConfig["retrieve"]>, "rewrite"> & { rewrite?: Step | string }

export interface QueryTemplate extends TemplateBase {
  needs_key: boolean
  pipeline: { retrieve: TemplateRetrieve; answer?: Step }
}

export interface PipelineTemplates {
  index: IndexTemplate[]
  query: QueryTemplate[]
}

/** The order the cards are shown in: the everyday case first. */
export const INDEX_ORDER = ["text", "tables", "scanned", "manuals"]
export const QUERY_ORDER = ["balanced", "exact", "precision", "vague", "chat"]

/** The one card not from Pandion: shown disabled until it ships. */
export const COMING_NEXT: TemplateBase = {
  id: "split-tables",
  name: "Tables across pages",
  summary: "Joins a table that a page break cut in two, so its rows stay together.",
  good_for: "It suits long tables in reports and statements.",
}

/** The templates in `order`; any the list does not name keep their place after it. */
export function orderTemplates<T extends { id: string }>(list: readonly T[], order: readonly string[]): T[] {
  const at = (t: T) => (order.includes(t.id) ? order.indexOf(t.id) : order.length)
  return [...list].sort((a, b) => at(a) - at(b))
}

const isStep = (v: unknown): v is Step => typeof v === "object" && v !== null && typeof (v as Step).use === "string"

/** The pipeline the two templates make, as Build holds it. A rewrite of "none" is left out. */
export function composeConfig(index: IndexTemplate, query: QueryTemplate): PipelineConfig {
  const { rewrite, ...retrieve } = query.pipeline.retrieve
  return {
    index: index.pipeline.index,
    retrieve: { ...(isStep(rewrite) ? { rewrite } : {}), ...retrieve },
    ...(query.pipeline.answer ? { answer: query.pipeline.answer } : {}),
  }
}

type Part = { index?: PipelineConfig["index"]; retrieve?: TemplateRetrieve; answer?: Step }

function stepsOf(p: Part): [string, Step[]][] {
  const one = (s: unknown): Step[] => (isStep(s) ? [s] : [])
  const { index, retrieve, answer } = p
  return [
    ["Parse", one(index?.parse)],
    ["Clean", index?.clean ?? []],
    ["Chunk", one(index?.chunk)],
    ["Embed", one(index?.embed)],
    ["Store", one(index?.store)],
    ["Rewrite", one(retrieve?.rewrite)],
    ["Search", one(retrieve?.search)],
    ["Rerank", retrieve?.rerank ?? []],
    ["Answer", one(answer)],
  ]
}

/** "pdfium · header_footer_strip · ...": the strategies a template sets, in order. */
export function stepsLine(part: Part): string {
  return stepsOf(part)
    .flatMap(([, steps]) => steps.map((s) => s.use))
    .join(" · ")
}

/** One row per stage the composed pipeline has: its name and the strategies it uses. */
export function composedRows(config: PipelineConfig): { stage: string; use: string }[] {
  return stepsOf(config)
    .filter(([, steps]) => steps.length)
    .map(([stage, steps]) => ({ stage, use: steps.map((s) => s.use).join(", ") }))
}

export type MadePipeline = { ok: true; graph: PipelineGraph; note?: string } | { ok: false; problem: string }

/**
 * The composed pipeline as Build's column, on the documents and question in
 * use. `note` names any setting this server does not allow, which is dropped.
 */
export function templatePipeline(
  index: IndexTemplate,
  query: QueryTemplate,
  current: { documents: DocRef[]; question: AskQuestion },
  registry: Registry,
): MadePipeline {
  const config = composeConfig(index, query)
  const odd = unknownStrategy(config, registry)
  if (odd !== null) return { ok: false, problem: `This pipeline uses ${odd}, which this server does not have.` }
  const note = removedText(servedConfig(config, registry).removed) ?? undefined
  const graph = columnOf({ config, documents: current.documents, question: current.question }, registry)
  return note ? { ok: true, graph, note } : { ok: true, graph }
}

export function appliedLine(indexName: string, queryName: string, steps: number): string {
  return `Build now holds ${indexName} with ${queryName}: ${steps} steps.`
}
