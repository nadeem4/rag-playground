import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"

import { needsKey, useApiKey } from "@/api/apiKey"
import { api } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { Registry } from "@/api/types"
import { loadPayload, useArtifactPayload } from "@/api/useArtifact"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { useExplanations } from "@/api/useExplain"
import { KeyHint } from "@/components/ApiKeyControl"
import { EmptyState } from "@/components/EmptyState"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { blockingNode, PipelineColumn, type NodeErrors, type SweepPreset } from "@/components/pipeline/PipelineColumn"
import { Button } from "@/components/ui/button"
import {
  addCleaner,
  addReranker,
  ancestors,
  columnOrder,
  infoFor,
  initialGraph,
  readStoredGraph,
  removeNode,
  setConfig,
  setTransform,
  signature,
  storeGraph,
  titleFor,
  upstreamOfStage,
  type PipelineGraph,
} from "@/state/graph"
import { buildRunRequest, errorHeadline, foldRun, routeRunError, type Tracked } from "@/state/pipeline"

/**
 * Build: the pipeline column on the left, the selected card's output on the
 * right. The graph is the state; the column renders it.
 */
export function Shell() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return <Build registry={reg.registry} />
}

export function RegistryScreen({ state }: { state: ReturnType<typeof useRegistry> }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      {state.kind === "loading" ? (
        <p role="status" className="p-4 text-sm text-fg-muted">
          Loading transforms
        </p>
      ) : state.kind === "error" ? (
        <div role="alert" className="flex flex-col gap-2 p-4">
          <p className="text-sm font-medium text-danger">Could not load the transform registry</p>
          <p className="max-w-[82ch] font-mono text-xs text-fg-muted">{state.message}</p>
          <p className="text-sm text-fg-muted">Is the server running? Start it with uv run rag-playground.</p>
          <Button variant="outline" size="sm" className="self-start" onClick={state.retry}>
            Retry
          </Button>
        </div>
      ) : null}
    </main>
  )
}

function Build({ registry }: { registry: Registry }) {
  const [graph, setGraph] = useState<PipelineGraph>(() => readStoredGraph(registry) ?? initialGraph(registry))
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [tracked, setTracked] = useState<Tracked>({ results: {}, history: {} })
  const results: Record<string, NodeState> = tracked.results
  const [sigs, setSigs] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, NodeErrors>>({})
  const [columnError, setColumnError] = useState<string | null>(null)
  const run = useRun(runId)
  const { key: apiKey } = useApiKey()

  useEffect(() => storeGraph(graph), [graph])
  useEffect(() => setTracked((prev) => foldRun(prev, run.nodes)), [run.nodes])
  const explanations = useExplanations(graph.nodes)

  const busy = submitting || (runId !== null && !run.closed)
  const order = useMemo(() => columnOrder(graph), [graph])
  // Run all stops at the first card whose settings cannot run.
  const blocker = order.find((n) => blockingNode(graph, registry, explanations, n.id)?.id === n.id)
  const stale = useMemo(
    () => new Set(Object.keys(results).filter((id) => sigs[id] !== undefined && sigs[id] !== signature(graph, id, registry))),
    [results, sigs, graph, registry],
  )

  const edit = useCallback((next: PipelineGraph, touched?: string) => {
    setGraph(next)
    if (touched) {
      setErrors((e) => {
        if (!e[touched]) return e
        const { [touched]: _, ...rest } = e
        return rest
      })
    }
  }, [])

  async function start(target: string | undefined, force: boolean) {
    const source = graph.nodes.find((n) => n.stage === "source")
    if (source && !source.config.sha) {
      setErrors((e) => ({ ...e, [source.id]: { message: "Choose or upload a file first." } }))
      setSelected(source.id)
      return
    }
    setErrors({})
    setColumnError(null)
    setSubmitting(true)
    try {
      const { run_id } = await api.createRun(buildRunRequest(graph, { target, force }), { apiKey })
      const covered = target ? [target, ...ancestors(graph, target, registry)] : graph.nodes.map((n) => n.id)
      setSigs((s) => ({ ...s, ...Object.fromEntries(covered.map((id) => [id, signature(graph, id, registry)])) }))
      setSelected(target ?? order[order.length - 1]?.id ?? null)
      setRunId(run_id)
    } catch (err) {
      const routed = routeRunError(err, graph)
      if (routed.kind === "fields") setErrors({ [routed.nodeId]: { fields: routed.errors } })
      else if (routed.kind === "node") setErrors({ [routed.nodeId]: { message: routed.message } })
      else setColumnError(routed.message)
      if (routed.kind !== "column") setSelected(routed.nodeId)
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Open Compare on one card. The Matryoshka preset needs the model's native
   * width to know which dimensions exist; the Index card's last output has it,
   * so it rides along when known and Compare falls back to 1024 otherwise.
   */
  async function openSweep(id: string, preset?: SweepPreset) {
    storeGraph(graph)
    const q = new URLSearchParams({ node: id })
    if (preset) {
      q.set("preset", preset)
      const r = results[id]
      if (r?.artifact_id && !stale.has(id)) {
        const d = (await loadPayload(r.artifact_id).catch(() => null)) as { native_dim?: unknown } | null
        if (typeof d?.native_dim === "number") q.set("native", String(d.native_dim))
      }
    }
    window.location.assign(`/compare?${q.toString()}`)
  }

  const failedNode = order.find((n) => results[n.id]?.status === "failed" && !stale.has(n.id))

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-hairline md:grid-cols-[380px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
      <section aria-label="Pipeline" className="flex min-h-0 flex-col bg-surface">
        <div className="flex h-[40px] shrink-0 items-center justify-between gap-2 border-b border-hairline px-3">
          <h1 className="text-xl font-semibold">Pipeline</h1>
          <div className="flex items-center gap-2">
            {busy && runId ? (
              <Button variant="outline" size="sm" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
                Cancel
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy || Boolean(blocker)}
              title={blocker ? `Fix the ${titleFor(blocker)} settings to run the pipeline` : undefined}
              onClick={() => void start(undefined, false)}
            >
              {busy ? "Running" : "Run all"}
            </Button>
          </div>
        </div>
        {blocker ? (
          <p data-testid="run-all-blocked" className="border-b border-hairline px-3 py-2 text-xs text-danger">
            Fix the {titleFor(blocker)} settings to run the pipeline.
          </p>
        ) : null}
        {columnError || run.error ? (
          <div role="alert" className="flex flex-col gap-1 border-b border-hairline p-3">
            <p className="text-sm font-medium text-danger">{columnError ? "The pipeline cannot run" : "The run crashed"}</p>
            <p className="font-mono text-xs break-words whitespace-pre-wrap text-fg-muted">
              {columnError ?? errorHeadline(run.error ?? "")}
            </p>
          </div>
        ) : null}
        {run.warnings.length ? (
          <div className="flex flex-col gap-1 border-b border-hairline p-3">
            {run.warnings.map((w) => (
              <p key={w} className="text-xs text-fg-muted">
                {w}
              </p>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PipelineColumn
            graph={graph}
            registry={registry}
            results={results}
            stale={stale}
            selected={selected}
            busy={busy}
            errors={errors}
            onSelect={setSelected}
            onTransform={(id, t) => edit(setTransform(graph, id, t, registry), id)}
            onConfig={(id, c) => edit(setConfig(graph, id, c), id)}
            onRun={(id, force) => void start(id, force)}
            onAddCleaner={() => edit(addCleaner(graph, registry))}
            onAddReranker={() => edit(addReranker(graph, registry))}
            onRemove={(id) => {
              edit(removeNode(graph, id), id)
              if (selected === id) setSelected(null)
            }}
            onSweep={(id, preset) => void openSweep(id, preset)}
            explanations={explanations}
            history={tracked.history}
          />
          <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline px-3 py-2 text-xs text-fg-muted">
            <span className="flex items-center gap-2">
              <span aria-hidden className="h-[12px] border-l-3 border-solid border-fg-muted" />
              computed this run
            </span>
            <span className="flex items-center gap-2">
              <span aria-hidden className="h-[12px] border-l-3 border-dotted border-fg-muted" />
              from cache
            </span>
          </p>
        </div>
      </section>

      <InspectorPanel
        graph={graph}
        registry={registry}
        results={results}
        stale={stale}
        selected={selected}
        failedHint={failedNode?.id}
      />
    </main>
  )
}

/** Stages whose output is placed on the upstream chunk set's document. */
const RETRIEVAL = new Set(["retrieve", "rerank", "use_case"])

function InspectorPanel({
  graph,
  registry,
  results,
  stale,
  selected,
  failedHint,
}: {
  graph: PipelineGraph
  registry: Registry
  results: Record<string, NodeState>
  stale: Set<string>
  selected: string | null
  failedHint?: string
}) {
  const node = graph.nodes.find((n) => n.id === selected)
  const result = node ? results[node.id] : undefined
  const usable = result && (result.status === "done" || result.status === "cached") && !stale.has(result.id)
  const artifactId = usable ? result.artifact_id : undefined
  const type = node ? infoFor(registry, node)?.output : undefined

  // A cleaned document is drawn against the document before any cleaning;
  // retrieval is drawn on the chunk set its index was built from.
  const relatedStage = node?.stage === "clean" ? "parse" : node && RETRIEVAL.has(node.stage) ? "chunk" : undefined
  const related = node && relatedStage ? upstreamOfStage(graph, node.id, relatedStage) : undefined
  const relatedResult = related ? results[related.id] : undefined
  const relatedId = artifactId && relatedResult && !stale.has(related!.id) ? relatedResult.artifact_id : undefined

  // The parsed document the chunks were cut from (the last cleaner, else the
  // parser): "Show in PDF" reads its elements' pages and bboxes.
  const docNode = node && (node.stage === "chunk" || RETRIEVAL.has(node.stage)) ? upstreamOfStage(graph, node.id, ["clean", "parse"]) : undefined
  const docResult = docNode ? results[docNode.id] : undefined
  const docId = artifactId && docResult && !stale.has(docNode!.id) ? docResult.artifact_id : undefined

  const payload = useArtifactPayload(artifactId)
  const before = useArtifactPayload(relatedId)
  const parsed = useArtifactPayload(docId)
  const verb = node ? titleFor(node) : ""

  let body: ReactNode
  if (!node) {
    body = (
      <EmptyState title="Nothing selected">
        {failedHint ? `Select ${failedHint} to see why it failed.` : "Select a card in the pipeline to see its output here."}
      </EmptyState>
    )
  } else if (!result) {
    body = <EmptyState title={`${verb} has not run`}>Run it, or Run all, to see its output here.</EmptyState>
  } else if (stale.has(node.id)) {
    body = <EmptyState title="Output is out of date">This card or one above it changed since it last ran. Run it again to see the new output.</EmptyState>
  } else if (result.status === "running" || result.status === "pending") {
    body = (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Running {verb}
      </p>
    )
  } else if (result.status === "failed") {
    body = (
      <div role="alert" className="flex flex-col gap-1 p-4">
        <p className="text-sm font-medium text-danger">{verb} failed</p>
        <p className="max-w-[82ch] font-mono text-xs break-words text-fg-muted">{errorHeadline(result.error ?? "")}</p>
        {needsKey(node.transform, result.error) ? <KeyHint /> : null}
        <p className="text-sm text-fg-muted">The full traceback is on the card.</p>
      </div>
    )
  } else if (result.status === "skipped") {
    body = <EmptyState title={`${verb} was skipped`}>A card above it failed or the run was cancelled.</EmptyState>
  } else {
    const waitingBefore = relatedId && before.status.kind === "loading"
    const known = !before.data ? {} : relatedStage === "chunk" ? { chunks: before.data as never } : { before: before.data as never }
    const context = parsed.data ? { ...known, doc: parsed.data as never } : known
    body = (
      <ArtifactInspector
        type={type ?? "unknown"}
        data={payload.data}
        status={waitingBefore ? { kind: "loading" } : payload.status}
        context={context}
      />
    )
  }

  return (
    <section aria-label="Inspector" className="flex min-h-0 min-w-0 flex-col bg-surface">
      <div className="flex h-[40px] shrink-0 items-center justify-between gap-3 border-b border-hairline px-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-xl font-semibold">{node ? verb : "Inspector"}</h2>
          {node ? <span className="truncate font-mono text-xs text-fg-muted">{node.transform}</span> : null}
        </div>
        {artifactId ? (
          <div className="flex shrink-0 items-center gap-3 font-mono text-xs text-fg-muted">
            <span>{type}</span>
            <span title={artifactId}>{artifactId.slice(0, 12)}</span>
            {result?.duration_ms !== undefined ? (
              <span>
                {result.cache_hit ? "cached" : "computed"} {fmtMs(result.duration_ms)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
    </section>
  )
}
