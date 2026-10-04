import { useId, type ReactNode } from "react"

import type { GraphNode, JsonSchema, Registry } from "@/api/types"
import type { NodeErrors } from "@/components/pipeline/PipelineColumn"
import { TransformSelect } from "@/components/pipeline/TransformSelect"
import { needsApiKey } from "@/api/apiKey"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { Picker, type PickerOption } from "@/components/ui/Picker"
import { firstSentence } from "@/lib/sentence"
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl"
import { askNodes, infoFor, rewriteOf, transformsFor, upstreamFor, type PipelineGraph, type RewriteMode } from "@/state/graph"

/**
 * The three settings blocks of the Ask panel: Retrieval, Rerank and Answer.
 * Each edits one node of the pipeline graph, and each node's own settings are
 * the same schema form the cards use, so help text and validation match.
 * Each block shows its primary fields; the rest wait under a closed More.
 */

/** Technical names for the retrieve transforms. Unknown ones show their own name. */
export const RETRIEVAL_LABEL: Record<string, string> = { hybrid_rrf: "Hybrid (RRF)", dense: "Dense", bm25: "BM25" }

const RETRIEVAL_GLOSS: Record<string, string> = {
  hybrid_rrf: "Meaning search and keyword search, fused by reciprocal rank.",
  dense: "Meaning search over the embeddings.",
  bm25: "Keyword search.",
}

/** The reranker choices, in order. `null` is no reranker. */
export const RERANKERS: { name: string | null; label: string }[] = [
  { name: null, label: "None" },
  { name: "cross_encoder", label: "Cross-encoder" },
  { name: "mmr", label: "MMR" },
  { name: "llm_rerank", label: "LLM" },
]

export interface AskSettingsProps {
  graph: PipelineGraph
  registry: Registry
  /** `hasAnyKey`: true, false, or null while unknown. Only `false` disables a choice. */
  hasKey: boolean | null
  errors: Record<string, NodeErrors>
  onConfig: (id: string, config: Record<string, unknown>) => void
  onTransform: (id: string, transform: string) => void
  onReranker: (transform: string | null) => void
  onUseCase: (transform: "search" | "chat") => void
  /** Set how the question is rewritten before retrieval: `setRewrite` on the graph. */
  onRewrite: (mode: RewriteMode) => void
  /** Open Compare on a node. When given, the Retrieval block offers Compare searches. */
  onSweep?: (id: string) => void
}

function Block({ title, stage, children }: { title: string; stage: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-panel border border-hairline p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="font-mono text-xs text-fg-muted">{stage}</span>
      </div>
      {children}
    </section>
  )
}

const GLOSS = "text-xs leading-[1.5] text-fg-muted"

/** Why LLM and Chat are off: shown under the group and as the option's title. */
const LLM_REASON = "Add a key to use the LLM reranker"
const CHAT_REASON = "Add a key to turn Chat on"

/** The schema with only `keys` among its fields. */
function pick(schema: JsonSchema, keys: string[]): JsonSchema {
  const props = schema.properties ?? {}
  return {
    ...schema,
    properties: Object.fromEntries(keys.map((k) => [k, props[k]])),
    required: schema.required?.filter((k) => keys.includes(k)),
  }
}

/**
 * A node's schema form and any message the server sent about it. The fields
 * named in `primary` show at full weight; the others go under a closed More,
 * which opens by itself when the server names one of them in an error.
 */
function NodeForm({
  node,
  registry,
  errors,
  onConfig,
  titles,
  primary,
  hide = [],
}: {
  node: GraphNode
  registry: Registry
  errors?: NodeErrors
  onConfig: AskSettingsProps["onConfig"]
  titles?: Record<string, string>
  primary: string[]
  /** Fields another control owns, or that do not apply now: not shown at all. */
  hide?: string[]
}) {
  const info = infoFor(registry, node)
  const keys = Object.keys(info?.config_schema.properties ?? {}).filter((k) => !hide.includes(k))
  const front = keys.filter((k) => primary.includes(k))
  const rest = keys.filter((k) => !primary.includes(k))
  const restErrors = Object.fromEntries(Object.entries(errors?.fields ?? {}).filter(([path]) => rest.includes(path.split(".")[0])))
  const form = (fields: string[], fieldErrors?: Record<string, string[]>) =>
    info ? (
      <SchemaForm
        key={`${node.id}:${info.name}`}
        schema={pick(info.config_schema, fields)}
        value={node.config}
        onChange={(c) => onConfig(node.id, c)}
        errors={fieldErrors}
        learn={info.learn}
        titles={titles}
      />
    ) : null
  return (
    <>
      {front.length ? form(front, errors?.fields) : null}
      {rest.length ? (
        <details open={Object.keys(restErrors).length > 0 || undefined} className="min-w-0">
          <summary className="cursor-pointer text-xs font-medium text-fg-muted select-none">More</summary>
          <div className="pt-2">{form(rest, restErrors)}</div>
        </details>
      ) : null}
      {errors?.message ? <p className="text-xs break-words text-danger">{errors.message}</p> : null}
    </>
  )
}

/** The fields each block shows at full weight. Strategy, the reranker and Search / Chat are their own controls. */
const RETRIEVAL_PRIMARY = ["top_k"]
// A custom model's address and name only show when the model is custom: they belong with the model.
const MODEL_FIELDS = ["model", "custom_base_url", "custom_model"]
const RERANK_PRIMARY = ["top_k", ...MODEL_FIELDS]
const ANSWER_PRIMARY = MODEL_FIELDS

/** PRF's own fields, owned by the Rewrite control and shown only with PRF on. */
const PRF_FIELDS = ["query_expansion", "prf_docs", "prf_terms"]
const PRF_TITLES = { prf_docs: "Pieces to borrow from", prf_terms: "Terms to add" }
/** The rewrite query node's fields the Retrieval block shows; the question has its own box. */
const LLM_REWRITE_FIELDS = [...MODEL_FIELDS, "style"]

export const PRF_GLOSS =
  "Borrows the top dense hits' words for the keyword search. Helps a question in your own words, and can cost a place when the question already matches. No key."
export const LLM_GLOSS = "A model restates the question in the document's words. Needs a key."
const NONE_GLOSS = "The question is searched as you typed it."
const REWRITE_REASON = "Add a key to rewrite with a model"

/** Every field of `node` except `keep`. */
function allBut(registry: Registry, node: GraphNode, keep: string[]): string[] {
  return Object.keys(infoFor(registry, node)?.config_schema.properties ?? {}).filter((k) => !keep.includes(k))
}

function Rewrite(p: AskSettingsProps & { node: GraphNode }) {
  const prfAvailable = Boolean(p.registry.retrieve?.hybrid_rrf?.config_schema.properties?.query_expansion)
  const llmAvailable = Boolean(p.registry.query?.llm_rewrite)
  if (!prfAvailable && !llmAvailable) return null
  const mode = rewriteOf(p.graph)
  const llmOff = p.hasKey === false
  const choices: SegmentedOption[] = [{ value: "none", label: "None" }]
  if (prfAvailable) choices.push({ value: "prf", label: "PRF" })
  if (llmAvailable) choices.push({ value: "llm", label: "LLM", disabled: llmOff, title: llmOff ? REWRITE_REASON : undefined })
  const query = askNodes(p.graph).query
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SegmentedControl label="Rewrite" caption="always" options={choices} value={mode} onChange={(v) => p.onRewrite(v as RewriteMode)} />
      {llmOff && llmAvailable ? <p className={GLOSS}>{REWRITE_REASON}</p> : null}
      <p className={GLOSS}>{mode === "prf" ? PRF_GLOSS : mode === "llm" ? LLM_GLOSS : NONE_GLOSS}</p>
      {mode === "prf" ? (
        <NodeForm
          node={p.node}
          registry={p.registry}
          errors={{ fields: p.errors[p.node.id]?.fields }}
          onConfig={p.onConfig}
          titles={PRF_TITLES}
          primary={["prf_docs", "prf_terms"]}
          hide={allBut(p.registry, p.node, ["prf_docs", "prf_terms"])}
        />
      ) : null}
      {mode === "llm" && query ? (
        <NodeForm
          node={query}
          registry={p.registry}
          errors={p.errors[query.id]}
          onConfig={p.onConfig}
          primary={LLM_REWRITE_FIELDS}
          hide={allBut(p.registry, query, LLM_REWRITE_FIELDS)}
        />
      ) : null}
    </div>
  )
}

function Retrieval({ node, ...p }: AskSettingsProps & { node: GraphNode }) {
  const id = useId()
  const gloss = RETRIEVAL_GLOSS[node.transform] ?? infoFor(p.registry, node)?.summary
  return (
    <Block title="Retrieval" stage="retrieve">
      <TransformSelect
        id={`${id}-strategy`}
        label="Strategy"
        transforms={transformsFor(p.registry, "retrieve")}
        value={node.transform}
        upstream={upstreamFor(p.graph, p.registry, node.id)}
        labelFor={(name) => RETRIEVAL_LABEL[name] ?? name}
        hasKey={p.hasKey}
        onChange={(t) => p.onTransform(node.id, t)}
      />
      {gloss ? <p className={GLOSS}>{gloss}</p> : null}
      <Rewrite {...p} node={node} />
      <NodeForm
        node={node}
        registry={p.registry}
        errors={p.errors[node.id]}
        onConfig={p.onConfig}
        titles={{ top_k: "Candidates, top k", rrf_k: "RRF k", ...PRF_TITLES }}
        primary={RETRIEVAL_PRIMARY}
        hide={PRF_FIELDS}
      />
      {p.onSweep ? (
        <Button variant="ghost" size="sm" className="self-start" title="Run this search beside the other strategies on the Compare page" onClick={() => p.onSweep!(node.id)}>
          Compare searches
        </Button>
      ) : null}
    </Block>
  )
}

function Rerank({ node, ...p }: AskSettingsProps & { node?: GraphNode }) {
  // No reranker is the empty value, since the control's values are strings.
  const labelId = useId()
  const choices: PickerOption[] = RERANKERS.filter((r) => r.name === null || p.registry.rerank?.[r.name]).map((r) => {
    const summary = r.name ? p.registry.rerank?.[r.name]?.summary : undefined
    return r.name === null
      ? { value: "", name: "No reranker", help: "Keeps the search order as it is." }
      : { value: r.name, name: r.label, code: r.name, help: summary ? firstSentence(summary) : undefined, needsKey: p.hasKey === false && needsApiKey(r.name) }
  })
  const gloss = node ? infoFor(p.registry, node)?.summary : "No reranker. The candidates keep their search order."
  return (
    <Block title="Rerank" stage="rerank">
      <label id={labelId} htmlFor={`${labelId}-picker`} className="text-sm font-medium">
        Reranker
      </label>
      <Picker id={`${labelId}-picker`} labelledBy={labelId} options={choices} value={node?.transform ?? ""} onChange={(v) => p.onReranker(v || null)} />
      {p.hasKey === false && p.registry.rerank?.llm_rerank && node?.transform !== "llm_rerank" ? <p className={GLOSS}>{LLM_REASON}</p> : null}
      {gloss ? <p className={GLOSS}>{gloss}</p> : null}
      {node ? (
        <NodeForm node={node} registry={p.registry} errors={p.errors[node.id]} onConfig={p.onConfig} titles={{ top_k: "Keep, top k" }} primary={RERANK_PRIMARY} />
      ) : null}
    </Block>
  )
}

function Answer({ node, ...p }: AskSettingsProps & { node: GraphNode }) {
  const choices: SegmentedOption[] = [{ value: "search", label: "Search" }]
  if (p.registry.use_case?.chat) {
    const disabled = p.hasKey === false
    choices.push({ value: "chat", label: "Chat with a model", disabled, title: disabled ? CHAT_REASON : undefined })
  }
  return (
    <Block title="Answer" stage="use_case">
      <SegmentedControl label="Answer with" options={choices} value={node.transform} onChange={(v) => p.onUseCase(v as "search" | "chat")} />
      <p className={GLOSS}>Search shows the kept pieces. Chat writes an answer with citations.</p>
      {p.hasKey === false && p.registry.use_case?.chat ? <p className={GLOSS}>{CHAT_REASON}</p> : null}
      <NodeForm
        node={node}
        registry={p.registry}
        errors={p.errors[node.id]}
        onConfig={p.onConfig}
        titles={{ top_k: "Show, top k", max_snippet_chars: "Snippet length" }}
        primary={ANSWER_PRIMARY}
      />
    </Block>
  )
}

export function AskSettings(p: AskSettingsProps) {
  const { retrieve, rerank, useCase } = askNodes(p.graph)
  return (
    <div className="grid grid-cols-1 gap-3 @min-[840px]:grid-cols-3">
      {retrieve ? <Retrieval {...p} node={retrieve} /> : null}
      {retrieve ? <Rerank {...p} node={rerank} /> : null}
      {useCase ? <Answer {...p} node={useCase} /> : null}
    </div>
  )
}
