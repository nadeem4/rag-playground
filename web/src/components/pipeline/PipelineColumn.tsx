import { Fragment } from "react"
import { Plus } from "lucide-react"

import type { NodeState } from "@/api/runState"
import type { GraphNode, Registry, Stage } from "@/api/types"
import type { FieldErrors } from "@/components/fields/schema"
import { Button } from "@/components/ui/button"
import { columnOrder, COLUMN_STAGES, infoFor, terminalNode, titleFor, transformsFor, type PipelineGraph } from "@/state/graph"

import { NodeCard } from "./NodeCard"
import { QuestionField } from "./QuestionField"
import { SourcePicker, type SourceConfig } from "./SourcePicker"

/**
 * The pipeline column: a top-to-bottom rendering of the graph. It owns no
 * state; every edit is a graph operation passed up to the page.
 */

export interface NodeErrors {
  fields?: FieldErrors
  message?: string
}

/** A Compare preset a card can open with. */
export type SweepPreset = "matryoshka"

export interface PipelineColumnProps {
  graph: PipelineGraph
  registry: Registry
  results: Record<string, NodeState>
  /** Node ids whose stored result no longer matches the graph. */
  stale: Set<string>
  selected: string | null
  busy: boolean
  errors: Record<string, NodeErrors>
  onSelect: (id: string) => void
  onTransform: (id: string, transform: string) => void
  onConfig: (id: string, config: Record<string, unknown>) => void
  onRun: (id: string, force: boolean) => void
  onAddCleaner: () => void
  onAddReranker?: () => void
  onRemove: (id: string) => void
  onSweep: (id: string, preset?: SweepPreset) => void
}

/** Cards whose variants are worth comparing side by side. */
export const SWEEPABLE: Stage[] = ["parse", "chunk", "index", "retrieve"]

/** Where a stackable stage's "Add" button sits: after its last node, or after the card that feeds it. */
function addAnchor(order: GraphNode[], stage: Stage, feeder: Stage): GraphNode | undefined {
  return [...order].reverse().find((n) => n.stage === stage) ?? [...order].reverse().find((n) => n.stage === feeder)
}

export function PipelineColumn(p: PipelineColumnProps) {
  const order = columnOrder(p.graph).filter((n) => COLUMN_STAGES.includes(n.stage))
  const terminal = terminalNode(p.graph)
  const adds: { anchor?: GraphNode; label: string; onAdd?: () => void }[] = [
    { anchor: transformsFor(p.registry, "clean").length ? addAnchor(order, "clean", "parse") : undefined, label: "Add cleaner", onAdd: p.onAddCleaner },
    { anchor: transformsFor(p.registry, "rerank").length ? addAnchor(order, "rerank", "retrieve") : undefined, label: "Add reranker", onAdd: p.onAddReranker },
  ]

  return (
    <div className="grid min-w-0 grid-cols-1 gap-px bg-hairline">
      {order.map((node) => {
        const errs = p.errors[node.id]
        const title = titleFor(node)
        const stacked = infoFor(p.registry, node)?.stackable ?? false
        // Ask runs the question through to the end of the column.
        const runTarget = node.stage === "query" && terminal ? terminal.id : node.id
        const isQuestion = node.stage === "query" && "text" in (infoFor(p.registry, node)?.config_schema.properties ?? {})
        return (
          <Fragment key={node.id}>
            <NodeCard
              node={node}
              title={title}
              transforms={transformsFor(p.registry, node.stage)}
              result={p.results[node.id]}
              stale={p.stale.has(node.id)}
              selected={p.selected === node.id}
              busy={p.busy}
              fieldErrors={errs?.fields}
              message={errs?.message}
              onSelect={() => p.onSelect(node.id)}
              onTransform={(t) => p.onTransform(node.id, t)}
              onConfig={(c) => p.onConfig(node.id, c)}
              onRun={(force) => p.onRun(runTarget, force)}
              runTitle={runTarget !== node.id && terminal ? `Ask this question and run through ${titleFor(terminal)}` : undefined}
              showId={stacked}
              onRemove={stacked ? () => p.onRemove(node.id) : undefined}
              body={
                node.stage === "source" ? (
                  <SourcePicker
                    value={node.config as SourceConfig}
                    onChange={(c) => p.onConfig(node.id, { ...c })}
                    errors={errs?.fields ? Object.entries(errs.fields).flatMap(([k, msgs]) => msgs.map((m) => (k ? `${k}: ${m}` : m))) : undefined}
                  />
                ) : isQuestion ? (
                  <QuestionField
                    value={String(node.config.text ?? "")}
                    errors={errs?.fields?.text}
                    disabled={p.busy}
                    onChange={(text) => p.onConfig(node.id, { ...node.config, text })}
                    onSubmit={() => p.onRun(runTarget, false)}
                  />
                ) : undefined
              }
              actions={
                SWEEPABLE.includes(node.stage) ? (
                  <div className="ml-auto flex items-center gap-1">
                    {node.stage === "index" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Compare this index at Matryoshka dimensions from native down to 64, through to the results"
                        onClick={(e) => {
                          e.stopPropagation()
                          p.onSweep(node.id, "matryoshka")
                        }}
                      >
                        Sweep dimensions
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      title={`Compare this ${title} step across transforms and configs`}
                      onClick={(e) => {
                        e.stopPropagation()
                        p.onSweep(node.id)
                      }}
                    >
                      Sweep
                    </Button>
                  </div>
                ) : undefined
              }
            />
            {adds
              .filter((a) => a.anchor?.id === node.id && a.onAdd)
              .map((a) => (
                <div key={a.label} className="bg-surface px-3 py-2">
                  <Button variant="ghost" size="sm" onClick={a.onAdd}>
                    <Plus aria-hidden strokeWidth={1.75} />
                    {a.label}
                  </Button>
                </div>
              ))}
          </Fragment>
        )
      })}
    </div>
  )
}
