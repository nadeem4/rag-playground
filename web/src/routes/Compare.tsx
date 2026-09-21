import { useMemo, useState, type CSSProperties } from "react"
import { Plus } from "lucide-react"

import { api } from "@/api/client"
import type { VariantState } from "@/api/runState"
import type { ChunkSet, GraphNode, Registry, TransformInfo, Variant } from "@/api/types"
import { useArtifactPayload } from "@/api/useArtifact"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { EmptyState } from "@/components/EmptyState"
import { ChunkSetInspector } from "@/components/inspectors/ChunkSetInspector"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { SweepControl } from "@/components/SweepControl"
import { Button } from "@/components/ui/button"
import { columnOrder, defaultConfig, infoFor, readStoredGraph, STAGE_VERB, transformsFor, type PipelineGraph } from "@/state/graph"
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { tallyLine, tallySweep, variantLabels } from "@/state/sweep"

import { RegistryScreen } from "./Shell"

/**
 * Compare: sweep one node of the Build pipeline over N variants and show the
 * results side by side. Each variant sits in its own column, its editor above
 * its output, so a config and what it produced read together.
 */
export function Compare() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  const graph = readStoredGraph(reg.registry)
  const wanted = new URLSearchParams(window.location.search).get("node")
  const target = graph?.nodes.find((n) => n.id === wanted) ?? graph?.nodes.find((n) => n.stage === "chunk")
  if (!graph || !target || !graph.nodes.some((n) => n.stage === "source" && n.config.sha)) {
    return (
      <main className="flex min-h-0 flex-1 flex-col bg-surface">
        <EmptyState title="No pipeline to compare">
          Build a pipeline with a file and a Chunk step first, then press Sweep on the Chunk card.{" "}
          <a href="/" className="text-fg underline">
            Go to Build
          </a>
        </EmptyState>
      </main>
    )
  }
  return <Sweep registry={reg.registry} graph={graph} target={target} />
}

/** The node's own variant first, then every other transform of its stage on defaults. */
export function seedVariants(target: GraphNode, transforms: TransformInfo[]): Variant[] {
  const own: Variant = { transform: target.transform, config: target.config }
  const others = transforms.filter((t) => t.name !== target.transform).map((t) => ({ transform: t.name, config: defaultConfig(t) }))
  return [own, ...others]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function Sweep({ registry, graph, target }: { registry: Registry; graph: PipelineGraph; target: GraphNode }) {
  const transforms = transformsFor(registry, target.stage)
  const [variants, setVariants] = useState<Variant[]>(() => seedVariants(target, transforms))
  const [submitted, setSubmitted] = useState<Variant[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useRun(runId)
  const busy = submitting || (runId !== null && !run.closed)

  const stageOf = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage])), [graph])
  const tally = runId ? tallySweep(run.variants, stageOf, target.id) : null
  const labels = variantLabels(submitted, registry, target.stage)
  const upstream = columnOrder(graph).filter((n) => n.id !== target.id && (n.stage === "source" || n.stage === "parse" || n.stage === "clean"))
  const filename = String(graph.nodes.find((n) => n.stage === "source")?.config.filename ?? "")

  async function sweep() {
    setError(null)
    setSubmitting(true)
    try {
      const { run_id } = await api.createSweep({ graph, node_id: target.id, variants })
      setSubmitted(variants)
      setRunId(run_id)
    } catch (err) {
      const routed = routeRunError(err, graph)
      setError(
        routed.kind === "fields"
          ? `${routed.nodeId}: ` + Object.entries(routed.errors).map(([k, m]) => `${k} ${m.join(", ")}`).join("; ")
          : routed.message,
      )
    } finally {
      setSubmitting(false)
    }
  }

  const reshape = (next: Variant[]) => {
    setVariants(next)
    // A different number of variants no longer lines up with the results.
    if (next.length !== variants.length) {
      setRunId(null)
      setSubmitted([])
    }
  }

  const cols = Math.max(variants.length, 1)
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${cols}, minmax(400px, 1fr))` }
  const running = run.variants.length > 0 && !run.closed ? run.variants[run.variants.length - 1].index : null

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-xl font-semibold">Compare</h1>
          <p className="truncate text-sm text-fg-muted">
            The {STAGE_VERB[target.stage] ?? target.stage} step over{" "}
            <span className="font-mono">{filename}</span>, after{" "}
            {upstream
              .filter((n) => n.stage !== "source")
              .map((n) => n.transform)
              .join(", ") || "no steps"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => reshape([...variants, { transform: transforms[0].name, config: defaultConfig(transforms[0]) }])}>
            <Plus aria-hidden strokeWidth={1.75} />
            Add variant
          </Button>
          {busy && runId ? (
            <Button variant="outline" size="sm" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || variants.length === 0} onClick={() => void sweep()}>
            {busy ? "Sweeping" : `Sweep ${variants.length} ${variants.length === 1 ? "variant" : "variants"}`}
          </Button>
        </div>
      </div>

      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline px-3 py-2" aria-live="polite">
        {error ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error}
          </p>
        ) : tally ? (
          <>
            <p data-testid="tally" className="font-mono text-sm text-fg">
              {tallyLine(tally, target.stage)}
            </p>
            <p className="text-xs text-fg-muted">
              {running !== null
                ? `running variant ${running + 1} of ${submitted.length}`
                : run.closed
                  ? tally.parsed === 0
                    ? "Parse was already in the cache from an earlier run."
                    : "Every variant read the same parsed document."
                  : "starting"}
            </p>
            {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Each variant runs the pipeline up to the {STAGE_VERB[target.stage] ?? target.stage} step. Steps above it are shared, so they run once and the rest come from the cache.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-min gap-px bg-hairline" style={grid}>
          {variants.map((v, i) => (
            <SweepControl
              key={i}
              variant={v}
              transforms={transforms}
              changed={submitted[i] !== undefined && !same(submitted[i], v)}
              onChange={(nv) => setVariants(variants.map((x, j) => (j === i ? nv : x)))}
              onRemove={variants.length > 1 && !busy ? () => reshape(variants.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          {variants.map((_, i) => (
            <VariantResult
              key={i}
              state={run.variants.find((s) => s.index === i)}
              pending={runId !== null && i < submitted.length}
              label={labels[i]}
              targetId={target.id}
              type={infoFor(registry, { stage: target.stage, transform: submitted[i]?.transform ?? target.transform })?.output ?? "chunk_set"}
            />
          ))}
        </div>
      </div>
    </main>
  )
}

function VariantResult({
  state,
  pending,
  label,
  targetId,
  type,
}: {
  state?: VariantState
  pending: boolean
  label?: { transform: string; fields: [string, string][] }
  targetId: string
  type: string
}) {
  const node = state?.nodes[targetId]
  const ok = node && (node.status === "done" || node.status === "cached")
  const payload = useArtifactPayload(ok ? node.artifact_id : undefined)

  let body
  if (!pending) {
    body = <EmptyState title="Not swept yet">Press Sweep to run this variant.</EmptyState>
  } else if (!node || node.status === "pending" || node.status === "running") {
    body = (
      <p role="status" className="p-4 text-sm text-fg-muted">
        {state ? "Running" : "Waiting for earlier variants"}
      </p>
    )
  } else if (node.status === "failed") {
    body = (
      <div role="alert" className="flex flex-col gap-1 p-4">
        <p className="text-sm font-medium text-danger">This variant failed</p>
        <p className="font-mono text-xs break-words text-fg-muted">{errorHeadline(node.error ?? "")}</p>
        <details className="rounded-control border border-hairline">
          <summary className="flex h-row-compact items-center px-2 text-xs text-fg-muted select-none hover:bg-muted">Traceback</summary>
          <pre className="m-0 max-h-[240px] overflow-auto border-t border-hairline p-2 font-mono text-2xs text-fg-muted">{node.error}</pre>
        </details>
      </div>
    )
  } else if (node.status === "skipped") {
    body = <EmptyState title="Skipped">A step above it failed, or the sweep was cancelled.</EmptyState>
  } else {
    // Side by side there is no room for the chunk detail panel; the spine and
    // the boundaries over the text are what a comparison reads.
    body =
      type === "chunk_set" ? (
        <ChunkSetInspector chunkSet={payload.data as ChunkSet | undefined} status={payload.status} showDetail={false} />
      ) : (
        <ArtifactInspector type={type} data={payload.data} status={payload.status} />
      )
  }

  return (
    <section aria-label={`Result ${label?.transform ?? ""}`} className="flex min-w-0 flex-col bg-surface">
      <header className="flex min-h-[40px] flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h2 className="font-mono text-sm font-semibold">{label?.transform ?? "not swept"}</h2>
          {label?.fields.map(([k, v]) => (
            <span key={k} className="font-mono text-xs text-fg-muted">
              {k} <span className="text-fg">{v}</span>
            </span>
          ))}
        </div>
        {ok ? (
          <span className="font-mono text-xs text-fg-muted">
            {node.cache_hit ? "cached" : "computed"} {fmtMs(node.duration_ms)}
          </span>
        ) : null}
      </header>
      <div className="min-w-0 p-3">{body}</div>
    </section>
  )
}
