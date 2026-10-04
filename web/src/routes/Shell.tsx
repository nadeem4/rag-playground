import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"

import { hasAnyKey, needsKey, useApiKey } from "@/api/apiKey"
import { api } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { GraphNode, LlmSettings, Registry } from "@/api/types"
import { loadPayload, useArtifactPayload } from "@/api/useArtifact"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { useExplanations } from "@/api/useExplain"
import { KeyHint } from "@/components/ApiKeyControl"
import { DocumentNote, needsDocument } from "@/components/DocumentNote"
import { EmptyState } from "@/components/EmptyState"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { AskPanel } from "@/components/ask/AskPanel"
import { askSnapshot, logEntry, type AskSnapshot, type TranscriptEntry } from "@/components/ask/Transcript"
import { WhatYouAreSeeing } from "@/components/learn/WhatYouAreSeeing"
import { FirstRun } from "@/components/pipeline/FirstRun"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { blockingNode, PipelineColumn, type NodeErrors, type SweepPreset } from "@/components/pipeline/PipelineColumn"
import { PipelineBar } from "@/components/pipeline/PipelineBar"
import { RunStrip, stripSegments, type LiveRun, type StripLine } from "@/components/pipeline/RunStrip"
import { Button } from "@/components/ui/button"
import {
  addCleaner,
  ancestors,
  ASK_STAGES,
  askNodes,
  columnOrder,
  INDEX_STAGES,
  indexNode,
  infoFor,
  initialGraph,
  removeNode,
  setConfig,
  setReranker,
  setRewrite,
  setTransform,
  setUseCase,
  signature,
  storeGraph,
  titleFor,
  upstreamOfStage,
  useStoredGraph,
  type PipelineGraph,
} from "@/state/graph"
import { useDocument } from "@/state/document"
import { buildRunRequest, errorHeadline, foldRun, routeRunError, type Tracked } from "@/state/pipeline"
import {
  decodePipeline,
  droppedText,
  readCurrentId,
  readPipelines,
  sameGraph,
  savePipeline,
  setCurrentId,
  usableGraph,
  usePipelines,
} from "@/state/pipelines"

/**
 * Build: the index pipeline column on the left; on the right the Ask panel,
 * or the selected card's output. The graph is the state; both render it.
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

/**
 * Why Build the index is disabled by a step's settings. A missing document is
 * said by "Needs a document." instead, which is checked first.
 */
function blockedTitle(blocker: GraphNode): string {
  return `Fix the ${titleFor(blocker)} settings to run the pipeline.`
}

function Build({ registry }: { registry: Registry }) {
  // The working copy, a store every page reads (the header's Document control
  // too): whatever was last stored under its own key, else the graph of
  // whichever saved pipeline is selected (a session that starts with a
  // selection already made but no working-copy storage of its own yet), else
  // the default graph.
  const graph = useStoredGraph(registry, () => {
    const currentId = readCurrentId()
    const current = currentId ? readPipelines().find((p) => p.id === currentId) : undefined
    return (current ? usableGraph(current, registry) : null) ?? initialGraph(registry)
  })
  // The document comes from the bar in the header. Missing or none blocks a run.
  const { status: docStatus } = useDocument()
  const noDocument = needsDocument(docStatus)
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [tracked, setTracked] = useState<Tracked>({ results: {}, history: {} })
  const results: Record<string, NodeState> = tracked.results
  const [sigs, setSigs] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, NodeErrors>>({})
  const [columnError, setColumnError] = useState<string | null>(null)
  const run = useRun(runId)
  // The last run the Ask button started, and the questions asked in this tab.
  // Taken as Ask is pressed (question, pipeline, reranker, settings), with the run id once it starts.
  const [asked, setAsked] = useState<AskSnapshot | null>(null)
  // Whether the last run started was an Ask: its column error or crash is then also said in the panel.
  const [fromAsk, setFromAsk] = useState(false)
  // The node the last run was started for: Build the index says Building only for its own run.
  const [runTarget, setRunTarget] = useState<string | undefined>(undefined)
  // The steps the run in flight covers, and its id once it has one: the run strip
  // shows that run's own progress, not the last run's look.
  const [runSteps, setRunSteps] = useState<{ ids: Set<string>; runId: string | null } | null>(null)
  const { pipelines, currentId } = usePipelines()
  const pipelineName = pipelines.find((x) => x.id === currentId)?.name ?? "Working copy"
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const onLog = useCallback((entry: TranscriptEntry) => setTranscript((t) => logEntry(t, entry)), [])
  // The rerank result whose comparison the reader hid. Held here, so opening a
  // card and coming Back to Ask keeps it; a new Ask or another reranker opens it.
  const [comparisonHidden, setComparisonHidden] = useState<string | null>(null)
  const { keys } = useApiKey()

  // Which keys the server has. Null until it answers, and if it fails: then
  // Ask is left alone.
  const [server, setServer] = useState<LlmSettings | null>(null)
  useEffect(() => {
    api.llmSettings().then(setServer, () => setServer(null))
  }, [])

  // Set when a keyless Ask stopped before Chat. A new key clears it.
  const [keyNotice, setKeyNotice] = useState<string | null>(null)
  useEffect(() => setKeyNotice(null), [keys])

  useEffect(() => setTracked((prev) => foldRun(prev, run.nodes)), [run.nodes])
  const explanations = useExplanations(graph.nodes)

  const busy = submitting || (runId !== null && !run.closed)
  const building = busy && !fromAsk && runTarget !== undefined && runTarget === indexNode(graph)?.id
  // An Ask run has no target of its own (or the step before Chat when no key is set).
  const asking = busy && fromAsk && runTarget !== indexNode(graph)?.id
  const order = useMemo(() => columnOrder(graph), [graph])
  // Build the index runs the five index steps only, so only they can block it.
  const blocker = order.filter((n) => INDEX_STAGES.includes(n.stage)).find((n) => blockingNode(graph, registry, explanations, n.id)?.id === n.id)
  const stale = useMemo(
    () => new Set(Object.keys(results).filter((id) => sigs[id] !== undefined && sigs[id] !== signature(graph, id, registry))),
    [results, sigs, graph, registry],
  )

  const edit = useCallback((next: PipelineGraph, ...touched: string[]) => {
    storeGraph(next)
    if (touched.length) {
      setErrors((e) => {
        if (!touched.some((id) => e[id])) return e
        const rest = { ...e }
        for (const id of touched) delete rest[id]
        return rest
      })
    }
  }, [])

  const [barNotice, setBarNotice] = useState<string | null>(null)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("pipeline")
    if (!code) return
    const decoded = decodePipeline(code, registry)
    if (!decoded) {
      setBarNotice("This pipeline link could not be read.")
    } else {
      // A link can carry any name; clamp it to what Save as accepts (M2).
      const name = decoded.name.trim().slice(0, 60).trim() || "Shared pipeline"
      const existing = readPipelines().find((p) => p.name === name && sameGraph(p.graph, decoded.graph))
      if (existing) {
        setCurrentId(existing.id)
      } else {
        const result = savePipeline(name, decoded.graph)
        if (result?.dropped) setBarNotice(droppedText(result.dropped))
        if (!result) {
          // Keeping the old selection would let "Save changes" overwrite it with this graph.
          setCurrentId(null)
          setBarNotice("The shared pipeline could not be saved in this browser. It is loaded as the working copy.")
        }
      }
      edit(decoded.graph)
    }
    params.delete("pipeline")
    const rest = params.toString()
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount by design
  }, [registry])

  /**
   * `select` false leaves the right pane as it is: Build the index and Ask keep
   * the Ask panel in view. Resolves to the run id, or undefined when no run started.
   */
  async function start(target: string | undefined, force: boolean, select = true, ask = false): Promise<string | undefined> {
    setFromAsk(ask)
    setRunTarget(target)
    const source = graph.nodes.find((n) => n.stage === "source")
    if (source && !source.config.sha) {
      setErrors((e) => ({ ...e, [source.id]: { message: "Pick a document in the bar above first." } }))
      setSelected(source.id)
      return
    }
    setKeyNotice(null)
    // An Ask with no key anywhere would end in a chat traceback. Stop at
    // the card that feeds Chat instead, and say so in one sentence.
    let notice: string | null = null
    if (target === undefined && hasAnyKey(server, keys) === false) {
      const chat = graph.nodes.find((n) => n.stage === "use_case" && n.transform === "chat")
      const upstream = chat && chat.config.model !== "custom" ? graph.edges.find((e) => e.dst === chat.id)?.src : undefined
      if (upstream) {
        target = upstream
        notice = "Search results are ready. Add a key to get a written answer."
      }
    }
    setErrors({})
    setColumnError(null)
    const covered = target ? [target, ...ancestors(graph, target, registry)] : graph.nodes.map((n) => n.id)
    setRunSteps({ ids: new Set(covered), runId: null })
    setSubmitting(true)
    try {
      const { run_id } = await api.createRun(buildRunRequest(graph, { target, force }), { keys })
      setKeyNotice(notice)
      setRunSteps({ ids: new Set(covered), runId: run_id })
      setSigs((s) => ({ ...s, ...Object.fromEntries(covered.map((id) => [id, signature(graph, id, registry)])) }))
      if (select) setSelected(target ?? order[order.length - 1]?.id ?? null)
      setRunId(run_id)
      return run_id
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

  // Plan I-15: the first-visit card, whenever no file is selected. This
  // browser's uploads are in the bar's menu.
  const sourceNode = graph.nodes.find((n) => n.stage === "source")
  const firstRun = sourceNode !== undefined && !sourceNode.config.sha
  // The working copy's document may not exist in this browser (opened from a
  // share link, or a different machine). The bar decides, once its lists have
  // answered (M1); a file chosen on this page is never flagged.
  const missing = docStatus === "missing"

  // A new document clears the errors the old one left on the Document card.
  const sourceSha = String(sourceNode?.config.sha ?? "")
  const sourceId = sourceNode?.id
  useEffect(() => {
    if (!sourceId) return
    setErrors((e) => {
      if (!e[sourceId]) return e
      const rest = { ...e }
      delete rest[sourceId]
      return rest
    })
  }, [sourceSha, sourceId])

  const failedNode = order.find((n) => results[n.id]?.status === "failed" && !stale.has(n.id))

  // The run strip: the index steps in column order, and the one running now.
  const indexSteps = order.filter((n) => INDEX_STAGES.includes(n.stage))
  // Until the new run has its id, its steps have reported nothing: all to go.
  const live: LiveRun | undefined = busy && runSteps ? { ids: runSteps.ids, nodes: runSteps.runId === runId ? run.nodes : {} } : undefined
  const segments = stripSegments(indexSteps, results, stale, live)
  const runningStep = busy ? indexSteps.find((n) => results[n.id]?.status === "running") : undefined
  // The strip's own titles, so a stacked cleaner is named as its segment is (Clean 2).
  const stripTitle = (id: string) => segments.find((x) => x.id === id)?.title ?? ""
  const runningTitle = runningStep ? stripTitle(runningStep.id) : undefined
  const runningSince = runningStep ? results[runningStep.id]?.started_at : undefined
  const failedStep = indexSteps.find((n) => results[n.id]?.status === "failed" && !stale.has(n.id))
  // The last run was Build the index, and it has ended.
  const built = !busy && runId !== null && !fromAsk && runTarget !== undefined && runTarget === indexNode(graph)?.id
  let stripLine: StripLine = null
  if (building) stripLine = { kind: "building", title: runningTitle, startedAt: runningSince }
  else if (runningStep && runningTitle) stripLine = { kind: "running", title: runningTitle, startedAt: runningSince }
  // Refused before it started: no step ran, so the strip points at the note above the cards.
  else if (!busy && columnError) stripLine = { kind: "refused" }
  else if (!busy && failedStep) stripLine = { kind: "failed", title: stripTitle(failedStep.id) }
  else if (built && segments.length && segments.every((s) => s.state === "done" || s.state === "reused"))
    stripLine = { kind: "built", totalMs: indexSteps.reduce((sum, n) => sum + (results[n.id]?.duration_ms ?? 0), 0) }

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-hairline md:grid-cols-[380px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
      <section aria-label="Pipeline" className="flex flex-col bg-surface md:min-h-0">
        {/* Grows rather than clipping: on a touch screen its buttons are 44px tall. */}
        <div className="flex min-h-row shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-hairline px-3 py-1">
          <h1 className="text-xl font-semibold">Index pipeline</h1>
          <div className="flex items-center gap-2">
            {busy && runId ? (
              <Button variant="outline" size="sm" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
                Cancel
              </Button>
            ) : null}
            {noDocument ? <span className="text-xs text-fg-muted">Needs a document.</span> : null}
            <Button
              size="sm"
              busy={building}
              disabled={busy || Boolean(blocker) || firstRun || noDocument}
              title={noDocument ? "Needs a document." : blocker ? blockedTitle(blocker) : BUILD_TITLE}
              onClick={() => void start(indexNode(graph)?.id, false, false)}
            >
              {building ? "Building" : "Build the index"}
            </Button>
          </div>
        </div>
        <RunStrip segments={segments} line={stripLine} />
        <PipelineBar
          graph={graph}
          registry={registry}
          onLoad={(g) => {
            // Errors from the last run belong to the graph being replaced (M4).
            setErrors({})
            setColumnError(null)
            setKeyNotice(null)
            edit(g)
          }}
          notice={barNotice}
        />
        <p className="border-b border-hairline px-3 py-2 text-xs text-fg-muted">
          These five steps build the index. Retrieval, reranking and answering live in the Ask panel.
        </p>
        {/* On a first visit the first-visit card already asks for a document. */}
        {firstRun ? null : <DocumentNote action="build the index" changed={sourceNode ? stale.has(sourceNode.id) : false} className="mx-3 mt-3" />}
        {/* A source blocker is the no-file case, which the first-visit card covers. Right after a
            sample loads, the Document card's old explanation can linger for a moment; no red flash. */}
        {blocker && !firstRun && blocker.stage !== "source" ? (
          <p data-testid="run-all-blocked" className="border-b border-hairline px-3 py-2 text-xs text-danger">
            {blockedTitle(blocker)}
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
        {/* Keyed by the screen it holds: the column after a sample loads starts at the top,
            not at the first-visit card's scroll position. Below md the page scrolls as one. */}
        <div key={firstRun ? "first-run" : "column"} data-testid="pipeline-scroll" data-scroll-box className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          {firstRun && sourceNode ? (
            <FirstRun />
          ) : (
            <>
              <PipelineColumn
                graph={graph}
                registry={registry}
                results={results}
                stale={stale}
                selected={selected}
                busy={busy}
                errors={errors}
                missingSource={missing}
                onSelect={setSelected}
                onTransform={(id, t) => edit(setTransform(graph, id, t, registry), id)}
                onConfig={(id, c) => edit(setConfig(graph, id, c), id)}
                onRun={(id, force) => void start(id, force)}
                onAddCleaner={() => edit(addCleaner(graph, registry))}
                onRemove={(id) => {
                  edit(removeNode(graph, id), id)
                  if (selected === id) setSelected(null)
                }}
                onSweep={(id, preset) => void openSweep(id, preset)}
                explanations={explanations}
                history={tracked.history}
              />
            </>
          )}
        </div>
      </section>

      <InspectorPanel
        graph={graph}
        registry={registry}
        results={results}
        stale={stale}
        selected={selected}
        onSelect={setSelected}
        failedHint={failedNode && INDEX_STAGES.includes(failedNode.stage) ? titleFor(failedNode) : undefined}
        ask={
          <AskPanel
            graph={graph}
            registry={registry}
            results={results}
            stale={stale}
            busy={busy}
            asking={asking}
            buildingStep={building ? { title: runningTitle, startedAt: runningSince } : undefined}
            needsDocument={noDocument}
            keys={keys}
            server={server}
            explanations={explanations}
            errors={errors}
            keyNotice={keyNotice && !busy && !run.error && !failedNode ? keyNotice : null}
            asked={asked !== null && asked.runId === runId && !busy ? asked : null}
            runError={fromAsk && (columnError || run.error) ? "The run could not start. See the note above the cards." : null}
            transcript={transcript}
            comparisonHidden={comparisonHidden}
            onComparison={setComparisonHidden}
            onLog={onLog}
            onConfig={(id, c) => edit(setConfig(graph, id, c), id)}
            onTransform={(id, t) => edit(setTransform(graph, id, t, registry), id)}
            onReranker={(t) => {
              setComparisonHidden(null)
              edit(setReranker(graph, registry, t), ...ids(askNodes(graph).rerank))
            }}
            onUseCase={(t) => edit(setUseCase(graph, registry, t), ...ids(askNodes(graph).useCase))}
            onRewrite={(m) => edit(setRewrite(graph, registry, m), ...ids(askNodes(graph).query), ...ids(askNodes(graph).retrieve))}
            onSweep={(id) => void openSweep(id)}
            onAsk={() => {
              setComparisonHidden(null)
              const snap = askSnapshot(graph, registry, pipelineName)
              void start(undefined, false, false, true).then((id) => setAsked(id ? { ...snap, runId: id } : null))
            }}
          />
        }
      />
    </main>
  )
}

/** The id of a node that may be absent, as a list to spread into `edit`. */
const ids = (n: GraphNode | undefined) => (n ? [n.id] : [])

/** What the Build the index button does, for its tooltip. */
const BUILD_TITLE = "Runs Document, Parse, Clean, Chunk and Index with their current settings. A step whose settings have not changed is reused."

/** Stages whose output is placed on the upstream chunk set's document. */
const RETRIEVAL = new Set(["retrieve", "rerank", "use_case"])

function InspectorPanel({
  graph,
  registry,
  results,
  stale,
  selected,
  onSelect,
  failedHint,
  ask,
}: {
  graph: PipelineGraph
  registry: Registry
  results: Record<string, NodeState>
  stale: Set<string>
  selected: string | null
  onSelect: (id: string | null) => void
  failedHint?: string
  /** The Ask panel: shown when no card is selected, or when the selection is a step the panel edits. */
  ask: ReactNode
}) {
  const picked = graph.nodes.find((n) => n.id === selected)
  if (!picked || ASK_STAGES.includes(picked.stage)) {
    return (
      <section aria-label="Inspector" className="flex min-w-0 flex-col bg-surface md:min-h-0 md:overflow-y-auto">
        {failedHint ? <p className="px-3 pt-3 text-sm text-fg-muted">Select the {failedHint} card to see why it failed.</p> : null}
        {ask}
      </section>
    )
  }
  return <CardInspector graph={graph} registry={registry} results={results} stale={stale} node={picked} onBack={() => onSelect(null)} />
}

function CardInspector({
  graph,
  registry,
  results,
  stale,
  node,
  onBack,
}: {
  graph: PipelineGraph
  registry: Registry
  results: Record<string, NodeState>
  stale: Set<string>
  node: GraphNode
  /** Returns the right pane to the Ask panel. */
  onBack: () => void
}) {
  const result = results[node.id]
  const usable = result && (result.status === "done" || result.status === "cached") && !stale.has(result.id)
  const artifactId = usable ? result.artifact_id : undefined
  const type = infoFor(registry, node)?.output

  // A cleaned document is drawn against the document before any cleaning;
  // retrieval is drawn on the chunk set its index was built from.
  const relatedStage = node.stage === "clean" ? "parse" : RETRIEVAL.has(node.stage) ? "chunk" : undefined
  const related = relatedStage ? upstreamOfStage(graph, node.id, relatedStage) : undefined
  const relatedResult = related ? results[related.id] : undefined
  const relatedId = artifactId && relatedResult && !stale.has(related!.id) ? relatedResult.artifact_id : undefined

  // The parsed document the chunks were cut from (the last cleaner, else the
  // parser): "Show in PDF" reads its elements' pages and bboxes.
  const docNode = node.stage === "chunk" || RETRIEVAL.has(node.stage) ? upstreamOfStage(graph, node.id, ["clean", "parse"]) : undefined
  const docResult = docNode ? results[docNode.id] : undefined
  const docId = artifactId && docResult && !stale.has(docNode!.id) ? docResult.artifact_id : undefined

  const payload = useArtifactPayload(artifactId)
  const before = useArtifactPayload(relatedId)
  const parsed = useArtifactPayload(docId)
  const verb = titleFor(node)

  let body: ReactNode
  if (!result) {
    body = <EmptyState title={`${verb} has not run`}>Run it, or Build the index, to see its output here.</EmptyState>
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
      <>
        {node.stage === "chunk" && payload.status.kind === "ready" ? <WhatYouAreSeeing data={payload.data} /> : null}
        <ArtifactInspector
          type={type ?? "unknown"}
          data={payload.data}
          status={waitingBefore ? { kind: "loading" } : payload.status}
          context={context}
        />
      </>
    )
  }

  return (
    <section aria-label="Inspector" className="flex min-w-0 flex-col bg-surface md:min-h-0">
      <div className="shrink-0 border-b border-hairline px-3 py-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to Ask
        </Button>
      </div>
      {/* Wraps rather than squeezing: at phone width the title and the artifact
          metadata each take a row, as on Compare and Evaluate. */}
      <div className="flex min-h-row shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-xl font-semibold">{verb}</h2>
          <span className="truncate font-mono text-xs text-fg-muted">{node.transform}</span>
        </div>
        {artifactId ? (
          <div className="flex shrink-0 items-center gap-3 text-xs text-fg-muted">
            <span className="font-mono">{type}</span>
            <span className="font-mono" title={artifactId}>
              {artifactId.slice(0, 12)}
            </span>
            {result?.duration_ms !== undefined ? (
              <span data-testid="inspector-timing">
                {result.cache_hit ? "reused from an earlier run" : "computed"} <span className="font-mono">{fmtMs(result.duration_ms)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="p-3 md:min-h-0 md:flex-1 md:overflow-y-auto">{body}</div>
    </section>
  )
}
