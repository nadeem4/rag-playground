import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { api } from "@/api/client"
import { QUEUED_LINE, type NodeState, type VariantState } from "@/api/runState"
import type { EvalPayload, Registry, RetrievalResult, SampleQuestion, Trace, TraceRequest, Variant } from "@/api/types"
import { useSamples } from "@/api/samples"
import { loadPayload } from "@/api/useArtifact"
import { usePayloads } from "@/api/usePayloads"
import { useQuestionSet } from "@/api/useQuestionSet"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { DocumentNote, needsDocument } from "@/components/DocumentNote"
import { EmptyState } from "@/components/EmptyState"
import { EvalNumbers } from "@/components/evaluate/EvalMetrics"
import { HowScored } from "@/components/evaluate/HowScored"
import { SideSheet } from "@/components/evaluate/SideSheet"
import { MissTrace } from "@/components/evaluate/MissTrace"
import { QuestionSetPanel } from "@/components/evaluate/QuestionSetPanel"
import { CONTROL } from "@/components/fields/types"
import { EvidenceSlip, LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { ordinal, rowsFromResult, scoreKey, type FindingPart } from "@/components/inspectors/hits"
import type { InspectorStatus } from "@/components/inspectors/status"
import { Button } from "@/components/ui/button"
import { Picker, type PickerOption } from "@/components/ui/Picker"
import { cn } from "@/lib/utils"
import {
  batches,
  changeFor,
  changeText,
  evalGraph,
  hasRetriever,
  isEvalOutput,
  metrics,
  metricsByTag,
  piecesWarning,
  pipelineLine,
  pipelineSteps,
  questionVariants,
  readPreviousEvaluation,
  reasonText,
  rerankEffect,
  rerankLine,
  SWEEP_LIMIT,
  storePreviousEvaluation,
  scoreFinding,
  summarize,
  fixHref,
  traceRequest,
  type PreviousEvaluation,
  type RowChange,
} from "@/state/evaluate"
import { inUse, questionsFromSample, questionsFromSet, sampleFor, type Question } from "@/state/goldSet"
import { columnOrder, upstreamOfStage, useStoredGraph, type PipelineGraph } from "@/state/graph"
import { evalStripLine, evidenceCells, indexSteps, progressLine, runSummary, searchSteps, slowReadNote, staleLine } from "@/state/evaluateView"
import { documentOf, useDocument, withDocument } from "@/state/document"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { RunStrip, stripSegments } from "@/components/pipeline/RunStrip"
import { FieldHelp } from "@/components/fields/FieldHelp"
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { sameGraph, usableGraph, usePipelines } from "@/state/pipelines"

import { RegistryScreen } from "./Shell"

/**
 * Evaluate: score a pipeline against the sample question set, so "did that
 * change help?" has a number behind it. The default is what Build shows: its
 * current saved pipeline while unedited, else Build's working copy. A picker
 * lets you score any saved pipeline instead.
 *
 * It takes the chosen graph, swaps the use case for `eval`, and sweeps the
 * question node over every question, each variant carrying the question and
 * the sentence that answers it. Only the use case changes, so parsing,
 * chunking and indexing come straight from the cache on the second run.
 *
 * The previous evaluation of each pipeline is kept in session storage, keyed
 * by document and pipeline, and every row says how it changed. Nothing is
 * stored between sessions.
 */

export function Evaluate() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return <EvaluatePage registry={reg.registry} />
}

/**
 * Reads the working graph as a store and the document from the header's bar,
 * so a document chosen on this page opens a fresh evaluation of it, with no
 * reload. A picked saved pipeline is scored on the bar's document too.
 */
function EvaluatePage({ registry }: { registry: Registry }) {
  const { pipelines, currentId } = usePipelines()
  const pickerId = useId()
  // null until the picker is used: the default follows Build (I1).
  const [choice, setChoice] = useState<string | null>(null)
  // True while an evaluation runs, so the pipeline under it cannot change (M8).
  const [busy, setBusy] = useState(false)
  // The header's slot for the body's two controls: set by the slot's ref callback.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // "How it is scored" opens in the side sheet, from the header or from the numbers.
  const [explaining, setExplaining] = useState(false)
  const explain = useCallback(() => setExplaining(true), [])
  const working = useStoredGraph(registry)
  const { doc, status } = useDocument()
  // A saved pipeline this server cannot run is listed but treated as absent (M7).
  const usable = new Map(pipelines.map((p) => [p.id, usableGraph(p, registry)]))
  const current = pipelines.find((p) => p.id === currentId) ?? null
  const currentGraph = current ? usable.get(current.id) : null
  // The current saved pipeline is the default only while Build shows it unedited;
  // otherwise Build's working copy is what "the pipeline on Build" means (I1).
  const unedited = Boolean(currentGraph && working && sameGraph(currentGraph, working))
  const chosenId = choice ?? (unedited ? currentId! : "")
  const chosen = pipelines.find((p) => p.id === chosenId && usable.get(p.id)) ?? null
  // Every page uses the bar's document: a saved pipeline is scored on it, whatever file it was saved with.
  const saved = chosen ? usable.get(chosen.id)! : null
  const graph = saved ? (doc ? withDocument(saved, doc) : saved) : working
  const sha = documentOf(graph)?.sha ?? ""
  // The working copy of saved pipeline A is scored under A's key, so editing A
  // and scoring it compares against A's last score.
  const pipelineKey = chosen ? chosen.id : (currentId ?? "working")
  const pipelineName = chosen
    ? chosen.name
    : current && currentGraph && !unedited
      ? `${current.name} (edited)`
      : "the pipeline on Build"
  const filename = String(graph?.nodes.find((n) => n.stage === "source")?.config.filename ?? "")
  // Saved pipelines, then the one on Build, each with its steps as the help line.
  const pipelineOptions: PickerOption[] = [
    ...pipelines.map((p) => ({
      value: p.id,
      name: p.name,
      help: pipelineLine(usable.get(p.id) ?? p.graph),
      group: "Saved",
      lock: usable.get(p.id) ? undefined : { kind: "hard" as const, reason: "This server does not have every step this pipeline uses." },
    })),
    {
      value: "",
      name: "The pipeline on Build",
      help: working ? pipelineLine(working) : undefined,
      group: "On Build",
      tags: current && currentGraph && !unedited ? [{ label: "Edited since saved", tone: "soft" as const }] : undefined,
    },
  ]
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
      <div className="flex flex-col gap-6 px-4 pt-4 pb-8 md:px-6">
        <header data-testid="evaluate-header" className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold">Evaluate</h1>
            <div className="flex max-w-[70ch] flex-col gap-1 text-sm text-fg-muted">
              {filename ? (
                <p>
                  How often {pipelineName} finds the answer in <span className="font-mono break-words text-fg">{filename}</span>.
                </p>
              ) : null}
              <p data-testid="evaluate-description">
                Test the search with questions you already know the answers to. A question is found when its evidence comes back in the top
                pieces. No AI judges it, so the same pipeline always gets the same score.
              </p>
              <p>
                <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center underline")} aria-haspopup="dialog" onClick={explain}>
                  How it is scored
                </button>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {/* Outside the keyed body, so switching pipelines keeps this picker, and its focus (F5). */}
            <div className="flex w-[min(360px,100%)] min-w-0 flex-col gap-1">
              <label id={`${pickerId}-label`} htmlFor={pickerId} className="text-xs text-fg-muted select-none">
                Pipeline
              </label>
              <Picker
                id={pickerId}
                labelledBy={`${pickerId}-label`}
                options={pipelineOptions}
                value={chosen ? chosen.id : ""}
                disabled={busy}
                onChange={setChoice}
              />
            </div>
            {/* The body renders Pieces checked and the run button here, through a portal. */}
            <div ref={setSlot} className="flex flex-wrap items-end gap-3" />
          </div>
        </header>
        {graph ? <DocumentNote action="run the evaluation" /> : null}
        {/* Keyed by what is scored, not by the score key: an edited A and A share a key but not a graph.
            A new document opens a fresh body: its own question set and its own last run. */}
        {graph && !sha ? null : (
          <EvaluateBody
            key={`${chosen ? chosen.id : "working"}:${sha}`}
            graph={graph}
            pipelineKey={pipelineKey}
            registry={registry}
            onBusy={setBusy}
            slot={slot}
            needsDocument={needsDocument(status)}
            onExplain={explain}
          />
        )}
      </div>
      {explaining ? (
        <SideSheet title="How Evaluate scores a pipeline" onClose={() => setExplaining(false)}>
          <HowScored />
        </SideSheet>
      ) : null}
    </main>
  )
}

/**
 * The guards that depend on the chosen graph rather than the registry. Kept
 * free of hooks so a guard can fail on one pipeline and pass on the next
 * without breaking the rules of hooks; the hook-heavy body lives in
 * `Evaluation`, rendered only once every guard has passed.
 */
function EvaluateBody({
  graph,
  pipelineKey,
  registry,
  onBusy,
  slot,
  needsDocument,
  onExplain,
}: {
  graph: PipelineGraph | null
  pipelineKey: string
  registry: Registry
  onBusy: (busy: boolean) => void
  slot: HTMLElement | null
  /** The bar's document is missing or not chosen: the run button waits for one. */
  needsDocument: boolean
  onExplain: () => void
}) {
  const source = graph?.nodes.find((n) => n.stage === "source")
  const sourceSha = String(source?.config.sha ?? "")
  const query = graph?.nodes.find((n) => n.stage === "query")
  const useCase = graph?.nodes.find((n) => n.stage === "use_case")
  if (!graph || !sourceSha || !query || !useCase) {
    return (
      <Blocked title="No pipeline to evaluate">
        Build a pipeline first, then come back here to score what it finds.
      </Blocked>
    )
  }
  if (!hasRetriever(graph)) {
    return (
      <Blocked title="This pipeline has no retriever">
        An evaluation scores what retrieval found, so the pipeline needs a Retrieve step. Check the pipeline on Build.
      </Blocked>
    )
  }
  if (!registry.use_case?.eval) {
    return (
      <Blocked title="This server has no eval step">
        Update the server, or run it from this repository, to score a pipeline here.
      </Blocked>
    )
  }
  return (
    <Evaluation
      registry={registry}
      graph={graph}
      queryId={query.id}
      useCaseId={useCase.id}
      sourceSha={sourceSha}
      pipelineKey={pipelineKey}
      onBusy={onBusy}
      slot={slot}
      needsDocument={needsDocument}
      onExplain={onExplain}
    />
  )
}

function Blocked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <EmptyState title={title}>
        {children}{" "}
        <a href="/build" className="text-fg underline">
          Go to Build
        </a>
      </EmptyState>
    </div>
  )
}

const finished = (n?: NodeState) => n !== undefined && (n.status === "done" || n.status === "cached")

/** One question, and everything this page knows about how it did. */
interface Row {
  question: Question
  payload?: EvalPayload
  /** What the miss trace asks for, once every step this question ran has finished. */
  trace: TraceRequest | null
  result?: RetrievalResult
  resultStatus: InspectorStatus
  failed?: NodeState
  started: boolean
}

/** What Pieces checked means, behind the same info button as every field on Build. */
const PIECES_HELP =
  "The search returns a ranked list of pieces. This is how many from the top are checked for the evidence. A chat model usually reads about 5, so evidence in 8th place counts as missed. A higher number is easier to pass and says less about the order."

const INDEX_STAGES = ["parse", "clean", "chunk", "index"]

function Evaluation({
  registry,
  graph,
  queryId,
  useCaseId,
  sourceSha,
  pipelineKey,
  onBusy,
  slot,
  needsDocument,
  onExplain,
}: {
  registry: Registry
  graph: PipelineGraph
  queryId: string
  useCaseId: string
  sourceSha: string
  pipelineKey: string
  onBusy: (busy: boolean) => void
  /** The header's slot, where Pieces checked and the run button go. */
  slot: HTMLElement | null
  /** The bar's document is missing or not chosen: the run button waits for one. */
  needsDocument: boolean
  onExplain: () => void
}) {
  const topKId = useId()
  const questionsId = useId()
  const query = graph.nodes.find((n) => n.id === queryId)!
  // The step whose hits the eval step reads: the last reranker, else Retrieve.
  const resultNode = upstreamOfStage(graph, useCaseId, ["rerank", "retrieve"])
  const defaultTopK = Number(registry.use_case?.eval?.config_schema?.properties?.top_k?.default ?? 5)
  const [topK, setTopK] = useState(defaultTopK)
  const [sample, setSample] = useState<SampleQuestion[] | null>(null)
  const [questionsError, setQuestionsError] = useState<string | null>(null)
  const [asked, setAsked] = useState<Question[]>([])
  // The k the shown run was scored at. Changing the input afterwards must not
  // rewrite what the rows of that run say.
  const [scoredK, setScoredK] = useState<number | null>(null)
  const shownK = scoredK ?? topK
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previous, setPrevious] = useState<PreviousEvaluation | null>(() => readPreviousEvaluation(sourceSha, pipelineKey))
  // The question whose details are open in the side sheet.
  const [detail, setDetail] = useState<string | null>(null)
  const run = useRun(runId)
  // More questions than one sweep takes run as several sweeps in a row
  // (SWEEP_LIMIT). `offset` is where the current sweep's first question sits in
  // the set, `earlier` holds the finished sweeps' variants under their place in
  // the set, and `rest` the sweeps still to start.
  const [offset, setOffset] = useState(0)
  const [earlier, setEarlier] = useState<VariantState[]>([])
  const [rest, setRest] = useState<{ offset: number; variants: Variant[] }[]>([])
  const [evalGraphUsed, setEvalGraphUsed] = useState<PipelineGraph | null>(null)
  // True from handing over to a new sweep until its state replaces the old
  // one: useRun resets on the next effect, so for one render `run` still
  // describes the sweep that just closed.
  const [handover, setHandover] = useState(false)
  useEffect(() => {
    if (handover && !run.closed) setHandover(false)
  }, [handover, run.closed])
  const busy = submitting || handover || (runId !== null && !run.closed) || rest.length > 0
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])

  // Which set is in use, and whether it belongs to the document on Build.
  const uploaded = useQuestionSet(sourceSha)
  const { samples, error: samplesError } = useSamples()
  const matched = sampleFor(sourceSha, samples)
  const which = inUse(sourceSha, samples, uploaded.set)
  const noBundledSet = samples !== null && !matched && !uploaded.set && !uploaded.loading
  const questions: Question[] | null = uploaded.set
    ? questionsFromSet(uploaded.set)
    : uploaded.loading
      ? null
      : sample
        ? questionsFromSample(sample)
        : null

  useEffect(() => {
    if (!matched) {
      setSample(null)
      return
    }
    let live = true
    api.sampleQuestions(matched.name).then(
      (qs) => live && setSample(qs),
      (err: unknown) => live && setQuestionsError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [matched?.name])

  const stateOf = (i: number) =>
    earlier.find((s) => s.index === i) ?? (handover ? undefined : run.variants.find((s) => s.index !== null && s.index + offset === i))

  // When a sweep ends and more are waiting, start the next. A cancelled or
  // crashed sweep ends the evaluation: what finished stays on the page.
  useEffect(() => {
    if (runId === null || !run.closed || rest.length === 0) return
    if (run.status === "cancelled" || run.error || !evalGraphUsed) {
      setRest([])
      return
    }
    const [next, ...after] = rest
    const finished = run.variants.map((v) => ({ ...v, index: v.index === null ? null : v.index + offset }))
    let live = true
    api
      .createSweep({ graph: evalGraphUsed, node_id: queryId, variants: next.variants, through: useCaseId })
      .then(
        ({ run_id }) => {
          if (!live) return
          setEarlier((e) => [...e, ...finished])
          setHandover(true)
          setOffset(next.offset)
          setRest(after)
          setRunId(run_id)
        },
        (err: unknown) => {
          if (!live) return
          setRest([])
          setError(err instanceof Error ? err.message : String(err))
        },
      )
    return () => {
      live = false
    }
  }, [runId, run.closed]) // eslint-disable-line react-hooks/exhaustive-deps
  const artifactOf = (i: number, id: string | undefined) => {
    const s = stateOf(i)
    return id && finished(s?.nodes[id]) ? s!.nodes[id].artifact_id : undefined
  }
  const ids = asked.map((_, i) => ({ out: artifactOf(i, useCaseId), result: artifactOf(i, resultNode?.id) }))

  // How many pieces the pipeline made, read once from the chunk step of the
  // first variant that finished it. Every variant shares that step.
  const chunkId = graph.nodes.find((n) => n.stage === "chunk")?.id
  const chunkArtifact = asked.map((_, i) => artifactOf(i, chunkId)).find((id) => id !== undefined)
  const [pieces, setPieces] = useState<number | null>(null)
  useEffect(() => {
    if (!chunkArtifact) {
      setPieces(null)
      return
    }
    let live = true
    loadPayload(chunkArtifact).then(
      (d) => {
        const chunks = (d as { chunks?: unknown } | null)?.chunks
        if (live) setPieces(Array.isArray(chunks) ? chunks.length : null)
      },
      () => live && setPieces(null),
    )
    return () => {
      live = false
    }
  }, [chunkArtifact])
  const payload = usePayloads(ids.flatMap((x) => [x.out, x.result]))

  const ran = runId !== null
  // Before a run the questions are listed as they will be asked; after, as they were.
  const listed = ran ? asked : (questions ?? [])
  const rows: Row[] = listed.map((question, i) => {
    if (!ran) return { question, trace: null, resultStatus: { kind: "ready" }, started: false }
    const s = stateOf(i)
    const out = payload(ids[i].out).data
    const got = payload(ids[i].result)
    const result = got.data as RetrievalResult | undefined
    const evaluated = isEvalOutput(out) ? out.payload : undefined
    return {
      question,
      payload: evaluated,
      trace: evaluated ? traceRequest(graph, (id) => artifactOf(i, id), question.gold_answers, shownK) : null,
      result: result && Array.isArray(result.hits) ? result : undefined,
      resultStatus: got.status,
      failed: s ? Object.values(s.nodes).find((n) => n.status === "failed") : undefined,
      started: s !== undefined,
    }
  })

  const scoredRows = ran ? rows : []
  const summary = summarize(scoredRows.map((r) => r.payload))
  const scores = metrics(scoredRows.map((r) => r.payload))
  // A number is compared only with a last run scored at the same Pieces checked.
  const beforeScores = previous && (previous.k === undefined || previous.k === shownK) ? metrics(Object.values(previous.byId)) : null
  const byTag = metricsByTag(scoredRows.map((r) => ({ tags: r.question.tags, payload: r.payload })))
  const effect = graph.nodes.some((n) => n.stage === "rerank")
    ? rerankEffect(scoredRows.map((r) => ({ payload: r.payload, rows: r.result ? rowsFromResult(r.result) : undefined })))
    : null
  const rerankText = effect ? rerankLine(effect) : null
  const settled = scoredRows.filter((r) => r.payload || r.failed).length
  const firstFailure = scoredRows.find((r) => r.failed)?.failed
  const steps = pipelineSteps(graph)
  const filename = String(graph.nodes.find((n) => n.stage === "source")?.config.filename ?? "")
  const misses = scoredRows.flatMap((r) => (r.payload && !r.payload.hit ? [r.payload] : []))
  const warning = piecesWarning(pieces, shownK, misses)
  const score = scoreFinding(
    summary,
    previous,
    scoredRows.map((r) => ({ now: r.payload, before: previous?.byId[r.question.id] })),
    steps,
    shownK,
  )
  const stale = ran && !busy ? staleLine(scoredK, topK) : null

  // While a run goes: is the index from the cache, and how far through the questions.
  const indexIds = columnOrder(graph)
    .filter((n) => INDEX_STAGES.includes(n.stage))
    .map((n) => n.id)
  const stepName = (id: string) => steps.find((s) => s.label.toLowerCase() === graph.nodes.find((n) => n.id === id)?.stage)?.label ?? id
  // Every sweep so far: the finished ones, then the one running.
  const allVariants = [...earlier, ...(handover ? [] : run.variants)]
  const firstStarted = stateOf(0) ?? allVariants[0]
  // The index steps as Build's run strip shows them: live while the run goes,
  // then each step done, reused from the cache, or failed.
  const indexNodes = columnOrder(graph).filter((n) => INDEX_STAGES.includes(n.stage))
  const firstNodes = firstStarted?.nodes ?? {}
  const segments = stripSegments(indexNodes, firstNodes, new Set(), busy ? { ids: new Set(indexIds), nodes: firstNodes } : undefined)
  const segmentTitle = (id: string) => segments.find((x) => x.id === id)?.title ?? stepName(id)
  const stripLine = evalStripLine(firstNodes, indexIds, segmentTitle, run.queued)
  const parseId = indexNodes.find((n) => n.stage === "parse")?.id
  const slowNote = slowReadNote(parseId ? firstNodes[parseId] : undefined)
  const current = settled < asked.length ? asked[settled]?.question : undefined
  const retrieveId = graph.nodes.find((n) => n.stage === "retrieve")?.id
  const cachedSearches = allVariants.filter((v) => retrieveId && v.nodes[retrieveId]?.status === "cached").length

  // Each row's element, so a mark can bring its row into view.
  const rowEls = useRef(new Map<string, HTMLLIElement>())
  function showRow(id: string) {
    rowEls.current.get(id)?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
  }

  // The finished evaluation on screen, to compare the next one against. It is
  // written to session storage as soon as it finishes, because changing a
  // setting means a trip to Build and a fresh page.
  const done = runId !== null && run.closed && rest.length === 0 && rows.length > 0 && rows.every((r) => r.payload !== undefined)
  // How long the whole evaluation took, every batch together, measured here.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [tookMs, setTookMs] = useState<number | null>(null)
  useEffect(() => {
    if (done && startedAt !== null) {
      setTookMs(Date.now() - startedAt)
      setStartedAt(null)
    }
  }, [done, startedAt])
  const finishedRun: PreviousEvaluation | null = done
    ? { sourceSha, pipelineKey, byId: Object.fromEntries(rows.map((r) => [r.question.id, r.payload!])), summary, steps, k: shownK }
    : null
  const fingerprint = finishedRun ? JSON.stringify(finishedRun.summary) + rows.map((r) => r.payload!.rank).join(",") : ""
  const latest = useRef<PreviousEvaluation | null>(null)
  latest.current = finishedRun
  useEffect(() => {
    if (latest.current) storePreviousEvaluation(latest.current)
  }, [fingerprint])

  async function evaluate() {
    if (!questions?.length) return
    setError(null)
    setSubmitting(true)
    setDetail(null)
    const before = finishedRun
    setStartedAt(Date.now())
    setTookMs(null)
    try {
      const g = evalGraph(graph, registry, topK)
      if (!g) throw new Error("This server has no eval step.")
      const [first, ...after] = batches(questionVariants(query, questions), SWEEP_LIMIT)
      const { run_id } = await api.createSweep({
        graph: g,
        node_id: queryId,
        variants: first.items,
        through: useCaseId,
      })
      setEarlier([])
      setOffset(0)
      setEvalGraphUsed(g)
      setRest(after.map((b) => ({ offset: b.offset, variants: b.items })))
      if (before) setPrevious(before)
      setAsked(questions)
      setScoredK(topK)
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

  const controls = (
    <>
      <div className="relative flex flex-col gap-1">
        <span className="flex items-center gap-1">
          <label htmlFor={topKId} className="text-xs text-fg-muted select-none">
            Pieces checked
          </label>
          <FieldHelp title="Pieces checked" text={PIECES_HELP} />
        </span>
        <input
          id={topKId}
          type="number"
          min={1}
          value={topK}
          disabled={busy}
          title="Top k: how many of the returned pieces are checked for the answer"
          onChange={(e) => setTopK(Math.max(1, Math.round(Number(e.target.value)) || 1))}
          className={cn(CONTROL, "w-[76px] font-mono tabular-nums")}
        />
      </div>
      {busy && runId ? (
        <Button
          variant="outline"
          onClick={() => {
            setRest([])
            void api.cancelRun(runId).catch(() => undefined)
          }}
        >
          Cancel
        </Button>
      ) : null}
      {needsDocument ? <span className="self-center text-xs text-fg-muted">Needs a document.</span> : null}
      <Button disabled={busy || !questions?.length || needsDocument} onClick={() => void evaluate()}>
        {busy ? "Evaluating" : runId ? "Evaluate again" : "Evaluate"}
      </Button>
    </>
  )

  const kLine = ran
    ? `Scored at ${shownK} ${shownK === 1 ? "piece" : "pieces"}.${pieces !== null ? ` The pipeline makes ${pieces} ${pieces === 1 ? "piece" : "pieces"}.` : ""}`
    : `Found means the evidence is in the top ${topK} ${topK === 1 ? "piece" : "pieces"}.`
  const search = searchSteps(graph, registry)
  const opened = detail ? rows.find((r) => r.question.id === detail) : undefined

  return (
    <div className="flex flex-col gap-6">
      {slot ? createPortal(controls, slot) : null}

      <div className="flex flex-col gap-2">
        <QuestionSetPanel
          inUse={which}
          set={uploaded.set}
          count={questions?.length ?? null}
          filename={filename}
          sampleName={matched?.title ?? null}
          report={uploaded.report}
          tabOnly={uploaded.tabOnly}
          error={uploaded.error}
          busy={uploaded.busy}
          disabled={busy}
          onUpload={(file) => void uploaded.upload(file)}
          onRemove={() => void uploaded.remove()}
          extra={questions?.length ? <span data-testid="k-line">{kLine}</span> : null}
        />
        {/* The recipe in two lines: the index side, then the search side. */}
        <p data-testid="recipe-line" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          <span>Index side:</span>
          {indexSteps(graph).map((s) => (
            <span key={s.label}>
              {s.label}: <strong className="font-semibold text-fg">{s.name}</strong>, <span className="font-mono">{s.transform}</span>
            </span>
          ))}
          <a href="/build" className="inline-flex items-center text-primary underline underline-offset-4">
            Change a step on Build
          </a>
        </p>
        <p data-testid="search-line" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          <span>Search side:</span>
          {search.map((s) => (
            <span key={s.label}>
              {s.label}: <strong className="font-semibold text-fg">{s.name}</strong>
              {s.transform ? (
                <>
                  , <span className="font-mono">{s.transform}</span>
                </>
              ) : null}
              {s.detail ? `, ${s.detail}` : null}
            </span>
          ))}
          <a href="/build" className="inline-flex items-center text-primary underline underline-offset-4">
            Change the search settings
          </a>
        </p>
      </div>

      <section aria-label="Score" className="flex flex-col gap-3">
        {error || questionsError || samplesError ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error ?? questionsError ?? samplesError}
          </p>
        ) : !ran ? (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-sm text-fg-muted">
              {questions
                ? `${questions.length} ${questions.length === 1 ? "question" : "questions"} ready. Press Evaluate to score this pipeline.`
                : noBundledSet
                  ? "No question set for this document. Upload one to evaluate it."
                  : "Loading the questions"}
            </p>
            {previous ? (
              <p data-testid="previous" className="text-sm text-fg-muted">
                The last evaluation in this tab found {previous.summary.hits} of {previous.summary.total}.
              </p>
            ) : null}
          </div>
        ) : busy ? (
          <div data-testid="progress" className="flex max-w-[40rem] flex-col gap-2 rounded-panel bg-surface-elevated p-3 text-sm">
            {run.queued ? (
              <p className="text-fg-muted">{QUEUED_LINE}</p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <strong className="font-semibold text-fg">Index</strong>
                  <RunStrip segments={segments} line={stripLine} bare />
                  {stripLine === null ? (
                    <span data-testid="index-line" className="text-xs text-fg-muted">
                      Waiting to start
                    </span>
                  ) : null}
                  {slowNote ? (
                    <p data-testid="slow-note" className="max-w-[60ch] text-xs text-fg-muted">
                      {slowNote}
                    </p>
                  ) : null}
                </div>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="font-semibold text-fg">Questions</strong>
                  <span data-testid="progress-line" className="text-fg-muted">
                    <MonoNumbers text={progressLine(settled, asked.length, cachedSearches)} />
                  </span>
                </p>
                {current ? (
                  <p data-testid="current-question" className="max-w-[60ch] truncate text-xs text-fg-muted">
                    Now: {current}
                  </p>
                ) : null}
                <div
                  role="progressbar"
                  aria-label="Questions scored"
                  aria-valuemin={0}
                  aria-valuemax={asked.length}
                  aria-valuenow={settled}
                  className="h-[6px] overflow-hidden rounded-full bg-surface"
                >
                  <span className="block h-full bg-primary" style={{ width: `${asked.length ? (settled / asked.length) * 100 : 0}%` }} />
                </div>
              </>
            )}
          </div>
        ) : (
          <div aria-live="polite" className="flex flex-col gap-2">
            <p data-testid="summary" className="max-w-[52ch] text-[1.375rem] leading-snug text-balance text-fg">
              <MonoNumbers text={score.finding} />
            </p>
            {score.note ? (
              <p data-testid="score-note" className="max-w-[70ch] text-fg-muted">
                <MonoNumbers text={score.note} />
              </p>
            ) : null}
          </div>
        )}
        {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}

        {ran && !busy && segments.length ? (
          <div data-testid="run-summary" className="flex max-w-[40rem] flex-col gap-1 text-sm">
            <RunStrip segments={segments} line={stripLine} bare />
            <p className="text-xs text-fg-muted">
              <MonoNumbers text={runSummary(asked.length, cachedSearches, tookMs)} />
            </p>
          </div>
        ) : null}

        {ran && !busy ? (
          <EvalNumbers metrics={scores} before={beforeScores} byTag={byTag} topK={shownK} rerank={rerankText} onExplain={onExplain} />
        ) : null}

        {ran && !run.queued ? (
          <div role="list" aria-label="One mark per question" className="flex flex-wrap gap-2">
            {rows.map((row, i) => (
              <span role="listitem" key={row.question.id} className="flex">
                <Mark n={i + 1} verdict={verdictOf(row, ran)} onPress={() => showRow(row.question.id)} />
              </span>
            ))}
          </div>
        ) : null}

        {stale ? (
          <p data-testid="stale-k" className="max-w-[70ch] rounded-panel bg-warn px-3 py-2 text-sm text-warn-text">
            {stale}
          </p>
        ) : null}

        {warning ? (
          <p role="status" data-testid="pieces-warning" className="max-w-[80ch] rounded-panel bg-warn px-3 py-2 text-sm text-warn-text">
            {warning}
          </p>
        ) : null}
      </section>

      {firstFailure ? (
        <p role="alert" className="font-mono text-xs break-words text-danger">
          {errorHeadline(firstFailure.error ?? "A step failed.")}
        </p>
      ) : null}

      {rows.length ? (
        <section aria-labelledby={questionsId} className="flex flex-col gap-2">
          <h2 id={questionsId} className="text-base font-semibold">
            Questions
          </h2>
          <ol className="m-0 list-none border-t border-hairline p-0">
            {rows.map((row) => (
              <QuestionRow
                key={row.question.id}
                row={row}
                ran={ran}
                before={previous?.byId[row.question.id]}
                topK={shownK}
                onDetail={() => setDetail(row.question.id)}
                rowRef={(el) => {
                  if (el) rowEls.current.set(row.question.id, el)
                  else rowEls.current.delete(row.question.id)
                }}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {opened ? (
        <SideSheet title={opened.question.question} onClose={() => setDetail(null)}>
          <QuestionDetail row={opened} graph={graph} />
        </SideSheet>
      ) : null}
    </div>
  )
}

type Verdict = "notrun" | "waiting" | "running" | "found" | "missed" | "failed"

function verdictOf(row: Row, ran: boolean): Verdict {
  if (!ran) return "notrun"
  if (!row.started) return "waiting"
  if (row.failed) return "failed"
  if (!row.payload) return "running"
  return row.payload.hit ? "found" : "missed"
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

const MARK: Record<Verdict, { glyph: string; tone: string }> = {
  found: { glyph: "✓", tone: "bg-kept text-kept-text" },
  missed: { glyph: "✕", tone: "bg-removed text-removed-text shadow-[inset_0_0_0_2px_var(--removed-mark)]" },
  failed: { glyph: "!", tone: "bg-removed text-danger" },
  waiting: { glyph: "", tone: "border border-hairline bg-surface text-fg-muted" },
  running: { glyph: "", tone: "border border-fg-muted bg-surface text-fg-muted" },
  notrun: { glyph: "", tone: "border border-hairline bg-surface text-fg-muted" },
}

/**
 * One question as a mark: a tick for found, a cross with a ring for missed, a
 * neutral outline while it waits or runs. 34 px square; a coarse pointer
 * grows it to 44 px through the touch rule in tokens.css. Pressing it brings
 * the question's row into view.
 */
function Mark({ n, verdict, onPress }: { n: number; verdict: Verdict; onPress: () => void }) {
  const m = MARK[verdict]
  return (
    <button
      type="button"
      aria-label={`Question ${n}, ${verdict}`}
      onClick={onPress}
      className={cn(
        "grid size-[34px] cursor-pointer place-items-center rounded-[9px] text-[0.9375rem] font-bold transition-transform duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) active:scale-[0.98] motion-reduce:transition-none",
        m.tone,
      )}
    >
      <span aria-hidden>{m.glyph}</span>
    </button>
  )
}

/** A gain reads on the kept hue, a loss on the removed one. */
const CHANGE_TONE: Record<RowChange, string> = {
  none: "",
  found: "text-kept-mark",
  up: "text-kept-mark",
  lost: "text-removed-mark",
  down: "text-removed-mark",
}

const VERDICT: Record<Verdict, { word: string; tone: string }> = {
  found: { word: "✓ Found", tone: "text-kept-text" },
  missed: { word: "✕ Missed", tone: "text-removed-mark" },
  failed: { word: "Failed", tone: "text-danger" },
  waiting: { word: "Waiting", tone: "text-fg-muted" },
  running: { word: "Running", tone: "text-fg-muted" },
  notrun: { word: "Not run", tone: "text-fg-muted" },
}

/** The evidence in the document's voice: a table row drawn as a row, a sentence as text. */
function Evidence({ gold }: { gold: string }) {
  const cells = evidenceCells(gold)
  if (cells) {
    return (
      <table className="border-collapse font-serif text-sm text-fg">
        <tbody>
          <tr>
            {cells.map((c, i) => (
              <td key={i} className="border border-hairline px-2 py-1 break-words">
                {c}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    )
  }
  return <p className="font-serif text-base leading-[1.55] break-words text-fg">{gold}</p>
}

/**
 * One question: the verdict in a word, the question with its id and tags, the
 * change since the last run on the right, the reason in a sentence, then the
 * expected answer beside the evidence. After a run, Details (and, on a miss,
 * Why did this miss?) opens the side sheet. On a phone the evidence folds away
 * after a run, since the sheet shows it.
 */
function QuestionRow({
  row,
  ran,
  before,
  topK,
  onDetail,
  rowRef,
}: {
  row: Row
  ran: boolean
  before?: EvalPayload
  topK: number
  onDetail: () => void
  rowRef?: (el: HTMLLIElement | null) => void
}) {
  const p = row.payload
  const change = changeFor(p, before)
  const moved = changeText(change, before)
  const verdictKind = verdictOf(row, ran)
  const verdict = VERDICT[verdictKind]
  const reason = row.failed ? errorHeadline(row.failed.error ?? "Failed") : p ? reasonText(p, topK) : null
  const gold = row.question.gold_answers[0]
  return (
    <li
      ref={rowRef}
      data-question={row.question.id}
      data-change={change === "none" ? undefined : change}
      className="grid grid-cols-1 items-baseline gap-x-[14px] gap-y-1 border-b border-hairline px-2 py-3 md:grid-cols-[92px_minmax(0,1fr)_auto]"
    >
      <span data-verdict="" className={cn("font-sans font-semibold", verdict.tone)}>
        {verdict.word}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span data-question-text="" className="text-base font-semibold text-fg">
          {row.question.question}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          <span className="font-mono">{row.question.id}</span>
          {row.question.tags.map((t) => (
            <span key={t} className="rounded-swatch bg-surface-elevated px-2">
              {t}
            </span>
          ))}
        </span>
        {reason ? (
          <span data-reason="" className={cn("font-sans text-sm", row.failed ? "break-words text-danger" : "text-fg-muted")}>
            <MonoNumbers text={reason} />
          </span>
        ) : null}
        <div
          data-evidence=""
          className={cn("mt-1 max-w-[72ch] grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-[minmax(10rem,0.6fr)_minmax(0,1.4fr)]", ran ? "hidden md:grid" : "grid")}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-fg-muted">Expected answer</span>
            <p className={cn("text-sm", row.question.answer ? "text-fg" : "text-fg-muted")}>{row.question.answer || "None given"}</p>
          </div>
          {gold ? (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-fg-muted">Evidence in the document</span>
              <Evidence gold={gold} />
            </div>
          ) : null}
        </div>
        {p ? (
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center underline")} onClick={onDetail}>
              Details
            </button>
            {p.hit ? null : (
              <button type="button" data-why="" className={cn(LINK_BUTTON, "inline-flex items-center font-semibold underline")} onClick={onDetail}>
                Why did this miss?
              </button>
            )}
          </span>
        ) : null}
      </div>
      {moved ? (
        <span data-row-change="" className={cn("text-[0.8125rem] font-semibold whitespace-nowrap", CHANGE_TONE[change])}>
          {moved}
        </span>
      ) : (
        <span aria-hidden className="hidden md:block" />
      )}
    </li>
  )
}

/**
 * The miss trace for a question, fetched once per request.
 */
function TraceSlot({ request, graph }: { request: TraceRequest; graph: PipelineGraph }) {
  const key = JSON.stringify(request)
  const [state, setState] = useState<{ key: string; trace?: Trace; error?: string } | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    api.trace(JSON.parse(key) as TraceRequest, ctrl.signal).then(
      (trace) => setState({ key, trace }),
      (err: unknown) => {
        if (!ctrl.signal.aborted) setState({ key, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => ctrl.abort()
  }, [key])
  const current = state?.key === key ? state : null
  return current?.trace ? (
    <MissTrace trace={current.trace} fixHref={fixHref(graph, current.trace)} />
  ) : current?.error ? (
    <p className="text-sm break-words text-danger">Could not trace this question: {current.error}</p>
  ) : (
    <p className="text-sm text-fg-muted">Following the answer through each step.</p>
  )
}

/** The slips shown before Show all. */
const TOP = 3

/**
 * A question's details in the side sheet: on a miss the trace first, then the
 * evidence and the expected answer, then what came back as evidence slips,
 * the top three first. The matched piece says it holds the answer.
 */
function QuestionDetail({ row, graph }: { row: Row; graph: PipelineGraph }) {
  const [all, setAll] = useState(false)
  const gold = row.question.gold_answers[0]
  const hits = row.result ? rowsFromResult(row.result) : []
  const shown = all ? hits : hits.slice(0, TOP)
  const scale = scoreKey(hits)
  const matched = row.payload?.hit ? row.payload.matched_chunk_id : null
  const holds = (rank: number): FindingPart[] => [{ text: ordinal(rank), place: true }, { text: ", holds the answer" }]
  const missed = row.payload !== undefined && !row.payload.hit
  return (
    <>
      {missed ? (
        <section data-testid="detail-trace" className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">Why did this miss?</h3>
          {row.trace ? <TraceSlot request={row.trace} graph={graph} /> : <p className="text-sm text-fg-muted">Following the answer through each step.</p>}
        </section>
      ) : null}
      {gold ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">The evidence</h3>
          <Evidence gold={gold} />
          <p className="text-sm text-fg-muted">Expected answer: {row.question.answer || "None given"}</p>
        </section>
      ) : null}
      <section data-open-row="" className="flex flex-col gap-3">
        {row.result ? (
          hits.length ? (
            <>
              <h3 className="text-base font-semibold">
                {hits.length > TOP ? `What came back, top ${TOP} of ${hits.length}` : `What came back, ${hits.length} ${hits.length === 1 ? "piece" : "pieces"}`}
              </h3>
              <div role="list" className="flex flex-col gap-3">
                {shown.map((h) => (
                  <EvidenceSlip
                    key={h.chunk_id}
                    role="listitem"
                    row={h}
                    side="single"
                    piece={h.ordinal}
                    scaleKey={scale}
                    finding={h.chunk_id === matched ? holds(h.rank) : undefined}
                  />
                ))}
              </div>
              {hits.length > TOP && !all ? (
                <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center self-start text-sm")} onClick={() => setAll(true)}>
                  Show all {hits.length}
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-fg-muted">Nothing came back for this question.</p>
          )
        ) : row.resultStatus.kind === "error" ? (
          <p className="text-sm break-words text-danger">{row.resultStatus.message}</p>
        ) : row.payload ? (
          <p className="text-sm text-fg-muted">Loading what came back.</p>
        ) : null}
      </section>
    </>
  )
}
