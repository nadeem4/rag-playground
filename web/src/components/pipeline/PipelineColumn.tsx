import { Fragment } from "react"
import { Plus } from "lucide-react"

import type { NodeState } from "@/api/runState"
import type { Registry } from "@/api/types"
import type { FieldErrors } from "@/components/fields/schema"
import { Button } from "@/components/ui/button"
import { columnOrder, COLUMN_STAGES, STAGE_VERB, transformsFor, type PipelineGraph } from "@/state/graph"

import { NodeCard } from "./NodeCard"
import { SourcePicker, type SourceConfig } from "./SourcePicker"

/**
 * The pipeline column: a top-to-bottom rendering of the graph. It owns no
 * state; every edit is a graph operation passed up to the page.
 */

export interface NodeErrors {
  fields?: FieldErrors
  message?: string
}

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
  onRemove: (id: string) => void
  onSweep: (id: string) => void
}

export function PipelineColumn(p: PipelineColumnProps) {
  const order = columnOrder(p.graph).filter((n) => COLUMN_STAGES.includes(n.stage))
  const lastClean = [...order].reverse().find((n) => n.stage === "clean")
  const parse = order.find((n) => n.stage === "parse")
  const addAfter = lastClean ?? parse
  const canClean = transformsFor(p.registry, "clean").length > 0

  return (
    <div className="grid min-w-0 grid-cols-1 gap-px bg-hairline">
      {order.map((node) => {
        const errs = p.errors[node.id]
        const isSource = node.stage === "source"
        return (
          <Fragment key={node.id}>
            <NodeCard
              node={node}
              title={STAGE_VERB[node.stage] ?? node.stage}
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
              onRun={(force) => p.onRun(node.id, force)}
              showId={node.stage === "clean"}
              onRemove={node.stage === "clean" ? () => p.onRemove(node.id) : undefined}
              body={
                isSource ? (
                  <SourcePicker
                    value={node.config as SourceConfig}
                    onChange={(c) => p.onConfig(node.id, { ...c })}
                    errors={errs?.fields ? Object.entries(errs.fields).flatMap(([k, msgs]) => msgs.map((m) => (k ? `${k}: ${m}` : m))) : undefined}
                  />
                ) : undefined
              }
              actions={
                node.stage === "chunk" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    title="Compare this chunk step across transforms and configs"
                    onClick={(e) => {
                      e.stopPropagation()
                      p.onSweep(node.id)
                    }}
                  >
                    Sweep
                  </Button>
                ) : undefined
              }
            />
            {canClean && addAfter && node.id === addAfter.id ? (
              <div className="bg-surface px-3 py-2">
                <Button variant="ghost" size="sm" onClick={p.onAddCleaner}>
                  <Plus aria-hidden strokeWidth={1.75} />
                  Add cleaner
                </Button>
              </div>
            ) : null}
          </Fragment>
        )
      })}
    </div>
  )
}
