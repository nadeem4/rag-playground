import { Fragment, useState } from "react"
import { Plus } from "lucide-react"

import type { NodeState } from "@/api/runState"
import type { GraphNode, Registry, Stage } from "@/api/types"
import { useStages, type ExplainState } from "@/api/useExplain"
import type { FieldErrors } from "@/components/fields/schema"
import { Button } from "@/components/ui/button"
import { compatibility } from "@/state/compat"
import { ancestors, columnOrder, INDEX_STAGES, infoFor, titleFor, transformsFor, upstreamFor, type PipelineGraph } from "@/state/graph"
import type { RunHistory } from "@/state/pipeline"

import { NodeCard } from "./NodeCard"

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
  /** The Document card's file is known to be gone from this browser (an expired upload). */
  missingSource?: boolean
  /** A card's id, or null when the selected card's head closes it. */
  onSelect: (id: string | null) => void
  /** The step whose output is on show beside the cards (desktop), if any. */
  showing?: string | null
  /** Show a step's output: the output icon and the result line. */
  onShowOutput?: (id: string) => void
  /** Open or close a card's settings only: the gear. */
  onSettings?: (id: string) => void
  onTransform: (id: string, transform: string) => void
  onConfig: (id: string, config: Record<string, unknown>) => void
  onRun: (id: string, force: boolean) => void
  onAddCleaner: () => void
  onRemove: (id: string) => void
  onSweep: (id: string, preset?: SweepPreset) => void
  /** Plan I-12, per node id: the explanation of each card's current settings. */
  explanations?: Record<string, ExplainState>
  /** Per node id: the current and previous run's artifacts, for "(was N)". */
  history?: Record<string, RunHistory>
}

/**
 * The card whose settings stop `id` from running: `id` itself, else the
 * nearest ancestor whose explanation is blocking. Running would only fail there.
 */
export function blockingNode(
  graph: PipelineGraph,
  registry: Registry,
  explanations: Record<string, ExplainState> | undefined,
  id: string,
): GraphNode | undefined {
  // A hard lock (a `requires` the upstream cannot meet) blocks exactly like a
  // blocking explanation: the run would fail at that card.
  const locked = (n: GraphNode) => {
    const info = infoFor(registry, n)
    return info ? compatibility(info, upstreamFor(graph, registry, n.id)).kind === "hard" : false
  }
  const blocking = (n: GraphNode) => explanations?.[n.id]?.data?.blocking === true || locked(n)
  const self = graph.nodes.find((n) => n.id === id)
  if (self && blocking(self)) return self
  const up = ancestors(graph, id, registry)
  return columnOrder(graph).filter((n) => up.has(n.id) && blocking(n)).pop()
}

/** Cards whose variants are worth comparing side by side. */
export const SWEEPABLE: Stage[] = ["parse", "chunk", "index"]

/** Where a stackable stage's "Add" button sits: after its last node, or after the card that feeds it. */
function addAnchor(order: GraphNode[], stage: Stage, feeder: Stage): GraphNode | undefined {
  return [...order].reverse().find((n) => n.stage === stage) ?? [...order].reverse().find((n) => n.stage === feeder)
}

export function PipelineColumn(p: PipelineColumnProps) {
  const order = columnOrder(p.graph).filter((n) => INDEX_STAGES.includes(n.stage))
  const stages = useStages()
  // One explanation pop-over at a time.
  const [open, setOpen] = useState<string | null>(null)
  const adds: { anchor?: GraphNode; label: string; onAdd?: () => void }[] = [
    { anchor: transformsFor(p.registry, "clean").length ? addAnchor(order, "clean", "parse") : undefined, label: "Add cleaner", onAdd: p.onAddCleaner },
  ]

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 bg-surface-elevated p-3">
      {/* The four looks of a step card, in words. */}
      <p data-testid="step-legend" className="m-0 text-xs text-fg-muted">
        Grey ring: not run. Half ring: running. Ring with a dot: done, dashed when reused. Amber ring: changed, run again.
      </p>
      {order.map((node) => {
        const errs = p.errors[node.id]
        const title = titleFor(node)
        const stacked = infoFor(p.registry, node)?.stackable ?? false
        return (
          <Fragment key={node.id}>
            <NodeCard
              node={node}
              title={title}
              transforms={transformsFor(p.registry, node.stage)}
              upstream={upstreamFor(p.graph, p.registry, node.id)}
              result={p.results[node.id]}
              stale={p.stale.has(node.id)}
              selected={p.selected === node.id}
              busy={p.busy}
              fieldErrors={errs?.fields}
              message={errs?.message}
              missing={node.stage === "source" && p.missingSource}
              onSelect={() => p.onSelect(node.id)}
              onDeselect={() => p.onSelect(null)}
              showing={p.showing === node.id}
              onShowOutput={p.onShowOutput ? () => p.onShowOutput!(node.id) : undefined}
              onSettings={p.onSettings ? () => p.onSettings!(node.id) : undefined}
              onTransform={(t) => p.onTransform(node.id, t)}
              onConfig={(c) => p.onConfig(node.id, c)}
              onRun={(force) => p.onRun(node.id, force)}
              explain={p.explanations?.[node.id]}
              what={stages[node.stage]?.what}
              lesson={stages[node.stage]?.lesson}
              explainOpen={open === node.id}
              onExplainOpenChange={(o) => setOpen((cur) => (o ? node.id : cur === node.id ? null : cur))}
              blockedBy={(() => {
                const b = blockingNode(p.graph, p.registry, p.explanations, node.id)
                return b ? titleFor(b) : undefined
              })()}
              previousArtifactId={p.history?.[node.id]?.previous}
              onRemove={stacked ? () => p.onRemove(node.id) : undefined}
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
                <div key={a.label}>
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
