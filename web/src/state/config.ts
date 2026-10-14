import type { GraphNode, Registry, Stage } from "@/api/types"

import { documentsOf, type DocRef } from "./document"
import { columnOrder, completeGraph, COLUMN_STAGES, defaultConfig, STAGE_VERB, titleFor, wire, type PipelineGraph } from "./graph"

/**
 * A pipeline as the browser holds it: the pipeline file's shape (spec rule 2),
 * the documents it runs on and the question Ask asks. `path`, `models` and
 * `plugins` are never here: the server decides them.
 *
 * `graphToConfig` is the one place that reads the old graph shape. It converts
 * what a browser already holds once (Build's working pipeline, the Library,
 * links, export files); what it cannot convert is kept and marked by its caller.
 */

/** One step of a pipeline file: the strategy it uses, then its settings. */
export type Step = { use: string } & Record<string, unknown>

export interface PipelineConfig {
  index: { source?: Step; parse: Step; clean?: Step[]; chunk: Step; embed?: Step; store: Step }
  retrieve?: { rewrite?: Step; search: Step; rerank?: Step[] }
  answer?: Step
}

/** The question Ask asks and, when known, the passages that answer it. Not part of a pipeline file. */
export interface AskQuestion {
  text: string
  gold_answers: string[]
}

export interface WorkingPipeline {
  config: PipelineConfig
  documents: DocRef[]
  question: AskQuestion
}

export type Converted = { ok: true; pipeline: WorkingPipeline } | { ok: false; problem: string }

/** Settings written under `embed` that the store takes with `embedder` (pandion.config.EMBED_KEYS). */
const EMBED_KEYS = ["truncate_dim"]
/** A query card's settings that are the question, not the rewrite step's. */
const QUESTION_KEYS = ["text", "gold_answer", "gold_answers"]
/** Stages a pipeline has at most one of. Clean and Rerank stack. */
const ONE_EACH: Stage[] = ["source", "parse", "chunk", "index", "query", "retrieve", "use_case"]

const no = (problem: string): Converted => ({ ok: false, problem })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const without = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)))
const step = (n: GraphNode, drop: readonly string[] = []): Step => ({ use: n.transform, ...without(n.config ?? {}, ["use", ...drop]) })

/** The card a step name is drawn as: `clean.2` is `clean_2`, `search` is `retrieve`. */
export function cardOfStep(step: string): string {
  const [name, n] = step.split(".")
  if (name === "clean" || name === "rerank") return `${name}_${n ?? "1"}`
  return ({ rewrite: "query", search: "retrieve", answer: "use_case" } as Record<string, string>)[name] ?? name
}

/** The step name a card runs as, in events and in `through`. */
export function stepOfCard(id: string): string {
  const m = /^(clean|rerank)_(\d+)$/.exec(id)
  if (m) return `${m[1]}.${m[2]}`
  return ({ query: "rewrite", retrieve: "search", use_case: "answer" } as Record<string, string>)[id] ?? id
}

/** A stacked step is numbered as `index.clean.2` in run events and as `index.clean step 2` in Pandion's problem sentences. */
const WHERE = /\b(?:index\.(parse|clean|chunk|embed|store|source)(?:(?:\.| step )(\d+))?|retrieve\.(rewrite|search|rerank)(?:(?:\.| step )(\d+))?)\b/
/** `answer` names the step only where a sentence or a clause starts, so "to answer the question" is not it. */
const ANSWER = /(?:^|[.:;]\s+)answer\b/

/** The card a Pandion problem sentence is about, from the place it names (`index.chunk`, `index.clean step 2`). */
export function cardNamedIn(sentence: string): string | null {
  const m = WHERE.exec(sentence)
  if (!m) return ANSWER.test(sentence) ? "use_case" : null
  const name = m[1] ?? m[3]
  const n = m[2] ?? m[4]
  if (name === "embed" || name === "store") return "index"
  if (name === "clean" || name === "rerank") return `${name}_${n ?? "1"}`
  return cardOfStep(name)
}

/**
 * The old graph as a config, or why it cannot be one. Structural: it needs no
 * registry, so it gives the same answer on any server. A graph converts when
 * its cards are the column's (one of each stage but Clean and Rerank) and each
 * card is fed by the one above it.
 */
export function graphToConfig(graph: unknown): Converted {
  if (!isRecord(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return no("It is not a pipeline: it has no steps.")
  const g = graph as unknown as PipelineGraph
  if (!g.nodes.every((n) => isRecord(n) && typeof n.id === "string" && typeof n.stage === "string" && typeof n.transform === "string")) {
    return no("It is not a pipeline: one of its steps has no name.")
  }
  if (!g.nodes.every((n) => n.config === undefined || isRecord(n.config))) return no("It is not a pipeline: one of its steps has broken settings.")
  if (!g.edges.every((e) => isRecord(e) && typeof e.src === "string" && typeof e.dst === "string")) {
    return no("It is not a pipeline: one of its connections is broken.")
  }
  const order = columnOrder(g)
  const odd = order.find((n) => !COLUMN_STAGES.includes(n.stage))
  if (odd) return no(`It has ${/^[aeiou]/i.test(odd.stage) ? "an" : "a"} ${odd.stage} step, and a pipeline in this version has no place for one.`)
  for (const stage of ONE_EACH) {
    const count = order.filter((n) => n.stage === stage).length
    if (count > 1) return no(`It has ${count} ${STAGE_VERB[stage] ?? stage} steps, and a pipeline has one.`)
  }
  const of = (stage: Stage) => order.filter((n) => n.stage === stage)
  const [source] = of("source")
  const [parse] = of("parse")
  const [chunk] = of("chunk")
  const [index] = of("index")
  const [query] = of("query")
  const [retrieve] = of("retrieve")
  const [useCase] = of("use_case")
  const cleans = of("clean")
  const reranks = of("rerank")
  if (!parse || !chunk || !index) return no("It has no Parse, Chunk or Index step, so it cannot build an index.")
  if (source && source.transform !== "upload") return no(`Its documents come from ${source.transform}, and this version reads uploaded files only.`)
  const rewrites = query !== undefined && query.transform !== "text"
  if (!retrieve && (rewrites || reranks.length || useCase)) return no("It rewrites, reranks or answers without a search step.")
  const fed = (a: GraphNode, b: GraphNode) => g.edges.some((e) => e.src === a.id && e.dst === b.id)
  const chains = [
    [source, parse, ...cleans, chunk, index].filter((n): n is GraphNode => n !== undefined),
    retrieve ? [index, retrieve, ...reranks, ...(useCase ? [useCase] : [])] : [],
  ]
  for (const chain of chains) {
    const broken = chain.slice(1).find((n, i) => !fed(chain[i], n))
    if (broken) return no(`Its ${titleFor(broken)} step is not fed by the step above it, so it is not a column of steps.`)
  }

  const { embedder, ...storeSettings } = index.config ?? {}
  const embeds = typeof embedder === "string"
  const config: PipelineConfig = {
    index: {
      parse: step(parse),
      ...(cleans.length ? { clean: cleans.map((n) => step(n)) } : {}),
      chunk: step(chunk),
      ...(embeds ? { embed: { use: embedder, ...only(storeSettings, EMBED_KEYS) } } : {}),
      store: { use: index.transform, ...without(storeSettings, embeds ? ["use", ...EMBED_KEYS] : ["use"]) },
    },
  }
  if (retrieve) {
    config.retrieve = {
      ...(query && query.transform !== "text" ? { rewrite: step(query, QUESTION_KEYS) } : {}),
      search: step(retrieve),
      ...(reranks.length ? { rerank: reranks.map((n) => step(n)) } : {}),
    }
    if (useCase) config.answer = step(useCase)
  }
  const q = query?.config ?? {}
  const golds = Array.isArray(q.gold_answers)
    ? q.gold_answers.filter((x): x is string => typeof x === "string" && x !== "")
    : typeof q.gold_answer === "string" && q.gold_answer
      ? [q.gold_answer]
      : []
  return {
    ok: true,
    pipeline: { config, documents: documentsOf(g), question: { text: typeof q.text === "string" ? q.text : "", gold_answers: golds } },
  }
}

/**
 * The column drawn from a config: the cards Build shows, with the positional
 * ids of Decision 4, every setting a step leaves out at its default, wired, and
 * with any default stage the config lacks added (an index-only pipeline still
 * shows Ask, Retrieve and Search).
 */
export function columnOf(p: WorkingPipeline, registry: Registry): PipelineGraph {
  const { index, retrieve, answer } = p.config
  const nodes: GraphNode[] = []
  const add = (id: string, stage: Stage, s: Step | undefined, extra: Record<string, unknown> = {}) => {
    if (!s) return
    const { use, ...settings } = s
    const info = registry[stage]?.[use]
    nodes.push({ id, stage, transform: use, config: { ...(info ? defaultConfig(info) : {}), ...settings, ...extra } })
  }
  const doc = p.documents[0]
  nodes.push({ id: "source", stage: "source", transform: index.source?.use ?? "upload", config: doc ? { sha: doc.sha, filename: doc.filename } : {} })
  add("parse", "parse", index.parse)
  index.clean?.forEach((s, i) => add(`clean_${i + 1}`, "clean", s))
  add("chunk", "chunk", index.chunk)
  const embed = index.embed ? { embedder: index.embed.use, ...without(index.embed, ["use"]) } : {}
  add("index", "index", index.store, embed)
  if (retrieve) {
    const asked = { text: p.question.text, ...(p.question.gold_answers.length ? { gold_answers: p.question.gold_answers } : {}) }
    add("query", "query", retrieve.rewrite ?? { use: "text" }, asked)
    add("retrieve", "retrieve", retrieve.search)
    retrieve.rerank?.forEach((s, i) => add(`rerank_${i + 1}`, "rerank", s))
    add("use_case", "use_case", answer)
  }
  return completeGraph(wire({ nodes, edges: [] }, registry), registry)
}

/** Every step names a strategy this server has. A pipeline from another server is listed but not opened (M7). */
export function knownSteps(config: PipelineConfig, registry: Registry): boolean {
  return unknownStrategy(config, registry) === null
}

/** The first strategy a step uses that this server does not have, or null when it has them all. */
export function unknownStrategy(config: PipelineConfig, registry: Registry): string | null {
  const { index, retrieve, answer } = config
  const steps: [Stage, Step | undefined][] = [
    ["parse", index.parse],
    ...(index.clean ?? []).map((s): [Stage, Step] => ["clean", s]),
    ["chunk", index.chunk],
    ["index", index.store],
    ["query", retrieve?.rewrite],
    ["retrieve", retrieve?.search],
    ...(retrieve?.rerank ?? []).map((s): [Stage, Step] => ["rerank", s]),
    ["use_case", answer],
  ]
  const odd = steps.find(([stage, s]) => s && !registry[stage]?.[s.use])
  return odd?.[1]?.use ?? null
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v

/** The same pipeline, whatever the order of its keys. */
export function sameConfig(a: PipelineConfig, b: PipelineConfig): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}
