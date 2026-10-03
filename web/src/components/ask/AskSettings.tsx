import { useId, type ReactNode } from "react"

import type { GraphNode, Registry } from "@/api/types"
import type { NodeErrors } from "@/components/pipeline/PipelineColumn"
import { TransformSelect } from "@/components/pipeline/TransformSelect"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { askNodes, infoFor, transformsFor, upstreamFor, type PipelineGraph } from "@/state/graph"

/**
 * The three settings blocks of the Ask panel: Retrieval, Rerank and Answer.
 * Each edits one node of the pipeline graph, and each node's own settings are
 * the same schema form the cards use, so help text and validation match.
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

function Segmented<T>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string
  choices: { value: T; label: string; disabled?: boolean }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {choices.map((c) => (
        <Button
          key={c.label}
          variant="outline"
          size="sm"
          disabled={c.disabled}
          aria-pressed={c.value === value}
          className={cn(c.value === value && "border-fg-muted bg-surface-elevated")}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </Button>
      ))}
    </div>
  )
}

/** A node's schema form and any message the server sent about it. */
function NodeForm({
  node,
  registry,
  errors,
  onConfig,
  titles,
}: {
  node: GraphNode
  registry: Registry
  errors?: NodeErrors
  onConfig: AskSettingsProps["onConfig"]
  titles?: Record<string, string>
}) {
  const info = infoFor(registry, node)
  return (
    <>
      {info ? (
        <SchemaForm
          key={`${node.id}:${info.name}`}
          schema={info.config_schema}
          value={node.config}
          onChange={(c) => onConfig(node.id, c)}
          errors={errors?.fields}
          learn={info.learn}
          titles={titles}
        />
      ) : null}
      {errors?.message ? <p className="text-xs break-words text-danger">{errors.message}</p> : null}
    </>
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
        onChange={(t) => p.onTransform(node.id, t)}
      />
      {gloss ? <p className={GLOSS}>{gloss}</p> : null}
      <NodeForm node={node} registry={p.registry} errors={p.errors[node.id]} onConfig={p.onConfig} titles={{ top_k: "Candidates, top k" }} />
    </Block>
  )
}

function Rerank({ node, ...p }: AskSettingsProps & { node?: GraphNode }) {
  const choices = RERANKERS.filter((r) => r.name === null || p.registry.rerank?.[r.name]).map((r) => ({
    value: r.name,
    label: r.label,
    disabled: r.name === "llm_rerank" && p.hasKey === false,
  }))
  const gloss = node ? infoFor(p.registry, node)?.summary : "No reranker. The candidates keep their search order."
  return (
    <Block title="Rerank" stage="rerank">
      <Segmented label="Reranker" choices={choices} value={node?.transform ?? null} onChange={p.onReranker} />
      {p.hasKey === false && p.registry.rerank?.llm_rerank ? <p className={GLOSS}>Add a key to use the LLM reranker</p> : null}
      {gloss ? <p className={GLOSS}>{gloss}</p> : null}
      {node ? <NodeForm node={node} registry={p.registry} errors={p.errors[node.id]} onConfig={p.onConfig} titles={{ top_k: "Keep, top k" }} /> : null}
    </Block>
  )
}

function Answer({ node, ...p }: AskSettingsProps & { node: GraphNode }) {
  const choices: { value: string; label: string; disabled?: boolean }[] = [{ value: "search", label: "Search" }]
  if (p.registry.use_case?.chat) choices.push({ value: "chat", label: "Chat with a model", disabled: p.hasKey === false })
  return (
    <Block title="Answer" stage="use_case">
      <Segmented label="Answer with" choices={choices} value={node.transform} onChange={(v) => p.onUseCase(v as "search" | "chat")} />
      {p.hasKey === false && p.registry.use_case?.chat ? <p className={GLOSS}>Add a key to turn Chat on</p> : null}
      <NodeForm node={node} registry={p.registry} errors={p.errors[node.id]} onConfig={p.onConfig} />
    </Block>
  )
}

export function AskSettings(p: AskSettingsProps) {
  const { retrieve, rerank, useCase } = askNodes(p.graph)
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {retrieve ? <Retrieval {...p} node={retrieve} /> : null}
      {retrieve ? <Rerank {...p} node={rerank} /> : null}
      {useCase ? <Answer {...p} node={useCase} /> : null}
    </div>
  )
}
