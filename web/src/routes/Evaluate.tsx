import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Circle, CircleAlert, Clock, LoaderCircle } from "lucide-react"

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
import { SideSheet } from "@/components/SideSheet"
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
import { columnOrder, storeGraph, upstreamOfStage, useStoredGraph, type PipelineGraph } from "@/state/graph"
import { evalStripLine, evidenceCells, indexSteps, progressLine, runSummary, searchSteps, slowReadNote, staleLine } from "@/state/evaluateView"
import { sameDocuments, useDocStatus, withDocuments, type DocRef } from "@/state/document"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { RunStrip, stripSegments } from "@/components/pipeline/RunStrip"
import { FieldHelp } from "@/components/fields/FieldHelp"
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { savePipeline, setCurrentId, usePipelines } from "@/state/pipelines"
import { BUILD_YOUR_OWN, defaultChoice, ON_BUILD, pipelineChoices, type PipelineChoice } from "@/state/pipelineChoice"
import { plantedLine, useStarter } from "@/state/starter"
import { DocumentControl } from "@/components/DocumentControl"
import { DocumentItem } from "@/components/DocumentItem"
import { BuildYourOwn } from "@/components/evaluate/BuildYourOwn"

import { RegistryScreen } from "./Shell"

/**
 * Evaluate: score a pipeline against its question set, so "did that change
 * help?" has a number behind it. The page is pipeline first: you pick a
 * pipeline (the ready-made Starter, a saved one, or the unsaved pipeline on
 * Build), and its documents come with it. Change tries it on another document
 * without altering a saved pipeline. Build your own makes a new one in a side
 * sheet. Arriving with nothing chosen opens on the Starter, ready to score.
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

const goTo = (href: string) => window.location.assign(href)

export function Evaluate({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return <EvaluatePage registry={reg.registry} navigate={navigate} />
}

/** The pipeline a link names (`?pipeline=<id>`, from Build after a save), read once and taken off the address. */
function takeWanted(): string | null {
  const params = new URLSearchParams(window.location.search)
  const wanted = params.get("pipeline")
  if (wanted === null) return null
  params.delete("pipeline")
  const rest = params.toString()
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""))
  return wanted
}

const names = (docs: readonly DocRef[]) => docs.map((d) => d.filename).join(", ")

/**
 * Reads the working graph and the saved pipelines as stores, so a pipeline
 * saved or changed elsewhere shows here with no reload.
 */
function EvaluatePage({ registry, navigate }: { registry: Registry; navigate: (href: string) => void }) {
  const { pipelines, currentId } = usePipelines()
  const { starter, unavailable: samplesFailed } = useStarter(registry)
  const pickerId = useId()
  const [wanted] = useState(takeWanted)
  // null until the picker is used: the default is worked out below.
  const [choice, setChoice] = useState<string | null>(null)
  // The documents this page is trying the chosen pipeline on, when not its own.
  const [trial, setTrial] = useState<{ id: string; documents: DocRef[] } | null>(null)
  const [building, setBuilding] = useState(false)
  // True while an evaluation runs, so the pipeline under it cannot change (M8).
  const [busy, setBusy] = useState(false)
  // The header's slot for the body's two controls: set by the slot's ref callback.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // "How it is scored" opens in the side sheet, from the header or from the numbers.
  const [explaining, setExplaining] = useState(false)
  const explain = useCallback(() => setExplaining(true), [])
  const working = useStoredGraph(registry)
  const choices = pipelineChoices({ starter, saved: pipelines, registry, working, currentId })
  const chosenId = choice ?? defaultChoice(choices, currentId, wanted)
  const chosen = choices.find((c) => c.id === chosenId && c.graph) ?? null
  const documents = trial && trial.id === chosen?.id ? trial.documents : (chosen?.documents ?? [])
  const graph = chosen?.graph ? withDocuments(chosen.graph, documents) : null
  const doc = documents[0] ?? null
  const status = useDocStatus(doc)
  const sha = doc?.sha ?? ""
  const tried = Boolean(chosen && trial && trial.id === chosen.id && !sameDocuments(trial.documents, chosen.documents))
  const pick = (id: string) => {
    if (id === BUILD_YOUR_OWN) setBuilding(true)
    else setChoice(id)
  }
  const unusable = "This server does not have every step this pipeline uses."
  const line = (c: PipelineChoice) => [c.graph ? pipelineLine(c.graph) : "", c.documents.length ? `On ${names(c.documents)}.` : ""].filter(Boolean).join(". ")
  // Ready to use, your pipelines, the unsaved one on Build, then the action.
  const pipelineOptions: PickerOption[] = [
    ...choices.map((c) => ({
      value: c.id,
      name: c.name,
      help: line(c),
      group: c.kind === "ready" ? "Ready to use" : c.kind === "saved" ? "Your pipelines" : "On Build",
      tags: c.kind === "ready" ? [READY_TAG] : c.kind === "build" ? [NOT_SAVED_TAG] : undefined,
      lock: c.graph ? undefined : { kind: "hard" as const, reason: unusable },
    })),
    { value: BUILD_YOUR_OWN, name: "Build your own…", help: "Pick a setting for each step, starting from the one selected.", action: true },
  ]
  const hint = tried
    ? `Trying ${chosen!.label} on ${names(documents)}.${chosen!.kind === "saved" ? ` The saved pipeline keeps ${names(chosen!.documents)}.` : ""}`
    : chosen?.kind === "ready"
      ? "The Starter comes with the default sample. Change it to try another."
      : null

  function saveOwn(name: string, g: PipelineGraph): string | null {
    const result = savePipeline(name, g, { documents, select: false })
    if (!result) return "The pipeline could not be saved in this browser."
    setChoice(result.saved.id)
    setTrial(null)
    setBuilding(false)
    return null
  }

  /** Change a step or the search settings: Build opens on the pipeline selected here, from Evaluate. */
  function openSelected() {
    if (!chosen?.graph) return
    if (chosen.id !== ON_BUILD) {
      storeGraph(withDocuments(chosen.graph, documents))
      setCurrentId(chosen.kind === "build" ? null : chosen.id)
    }
    navigate("/build?from=evaluate")
  }

  function openOnBuild(g: PipelineGraph) {
    storeGraph(withDocuments(g, documents))
    setCurrentId(null)
    navigate("/build?from=evaluate")
  }

  // Nothing to pick yet: the Starter waits on the samples list, or it could not be read.
  const waiting = !chosen && !choices.some((c) => c.graph)
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
      <div className="flex flex-col gap-6 px-4 pt-4 pb-8 md:px-6">
        <header data-testid="evaluate-header" className="grid grid-cols-1 items-start gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold">Evaluate</h1>
            <div className="flex max-w-[70ch] flex-col gap-1 text-sm text-fg-muted">
              {chosen && documents.length ? (
                <p>
                  How often {chosen.label} finds the answer in <span className="font-mono break-words text-fg">{names(documents)}</span>.
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
          <div className="flex min-w-0 flex-col gap-3">
            {/* Outside the keyed body, so switching pipelines keeps this picker, and its focus (F5). */}
            <div className="flex min-w-0 flex-col gap-1">
              <label id={`${pickerId}-label`} htmlFor={pickerId} className="text-xs text-fg-muted select-none">
                Pipeline
              </label>
              <Picker
                id={pickerId}
                labelledBy={`${pickerId}-label`}
                options={pipelineOptions}
                value={chosen?.id ?? ""}
                disabled={busy || waiting}
                onChange={pick}
              />
            </div>
            {chosen ? (
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-xs text-fg-muted">Documents</span>
                  {busy ? null : (
                    <DocumentControl
                      value={doc}
                      onChoose={(d) => setTrial({ id: chosen.id, documents: [d] })}
                      foot="Trying the pipeline on another document does not change it."
                    />
                  )}
                </div>
                <div data-testid="documents-line" className="flex min-w-0 flex-col gap-2">
                  {documents.length ? (
                    documents.map((d) => <DocumentItem key={d.sha} doc={d} />)
                  ) : (
                    <p className="text-sm text-fg-muted">None yet.</p>
                  )}
                </div>
                {hint ? (
                  <p data-testid="documents-hint" className="text-xs text-fg-muted">
                    {hint}
                  </p>
                ) : null}
              </div>
            ) : null}
            {/* The body renders Pieces checked and the run button here, through a portal. */}
            <div ref={setSlot} className="flex flex-wrap items-end gap-3" />
          </div>
        </header>
        {waiting ? (
          samplesFailed ? (
            <EmptyState title="The Starter pipeline is not ready">
              The samples could not be read, so the ready-made pipeline has no document.{" "}
              <a href="/build" className="text-fg underline">
                Build a pipeline on Build
              </a>
            </EmptyState>
          ) : (
            <p role="status" className="text-sm text-fg-muted">
              Getting the Starter pipeline ready
            </p>
          )
        ) : null}
        {graph ? <DocumentNote action="run the evaluation" where="under Documents" doc={doc} /> : null}
        {/* Keyed by what is scored: the pipeline and its document. A new document opens a fresh
            body: its own question set and its own last run. */}
        {!graph || !sha ? null : (
          <EvaluateBody
            key={`${chosen!.id}:${sha}`}
            graph={graph}
            pipelineKey={chosen!.key}
            registry={registry}
            onBusy={setBusy}
            slot={slot}
            needsDocument={needsDocument(status)}
            onExplain={explain}
            onOpenBuild={openSelected}
            replacesUnsaved={chosen!.id !== ON_BUILD && choices.some((c) => c.id === ON_BUILD)}
          />
        )}
      </div>
      {explaining ? (
        <SideSheet title="How Evaluate scores a pipeline" onClose={() => setExplaining(false)}>
          <HowScored />
        </SideSheet>
      ) : null}
      {building && chosen?.graph ? (
        <BuildYourOwn
          registry={registry}
          from={{ name: chosen.kind === "build" ? "the pipeline on Build" : chosen.name, graph: withDocuments(chosen.graph, documents) }}
          documents={documents}
          onSave={saveOwn}
          onOpenBuild={openOnBuild}
          replacesUnsaved={choices.some((c) => c.id === ON_BUILD)}
          onClose={() => setBuilding(false)}
        />
      ) : null}
    </main>
  )
}

const READY_TAG = { label: "Ready-made", tone: "plain" as const }
const NOT_SAVED_TAG = { label: "Not saved", tone: "soft" as const }

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
  onOpenBuild,
  replacesUnsaved,
}: {
  graph: PipelineGraph | null
  pipelineKey: string
  registry: Registry
  onBusy: (busy: boolean) => void
  slot: HTMLElement | null
  /** The bar's document is missing or not chosen: the run button waits for one. */
  needsDocument: boolean
  onExplain: () => void
  /** Open the selected pipeline on Build. */
  onOpenBuild: () => void
  /** Opening it on Build would replace an unsaved pipeline there. */
  replacesUnsaved: boolean
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
      onOpenBuild={onOpenBuild}
      replacesUnsaved={replacesUnsaved}
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
  onOpenBuild,
  replacesUnsaved,
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
  onOpenBuild: () => void
  replacesUnsaved: boolean
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
  const searchId = graph.nodes.find((n) => n.stage === "retrieve")?.id ?? queryId
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
      // A question's run builds the index first; it is running once Retrieve starts, the first
      // step that needs the finished index. (The question step has no inputs and runs at once.)
      started: s !== undefined && (s.nodes[searchId]?.status ?? "pending") !== "pending",
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
  // Only a sample's own set plants misses, and says so in its tags.
  const planted = !uploaded.set && questions ? plantedLine(questions) : null
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
          extra={
            questions?.length ? (
              <>
                <span data-testid="k-line">{kLine}</span>
                {planted ? (
                  <>
                    {" "}
                    <span data-testid="planted-line">{planted}</span>
                  </>
                ) : null}
              </>
            ) : null
          }
        />
        {/* The recipe in two lines: the index side, then the search side. */}
        <p data-testid="recipe-line" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          <span>Index side:</span>
          {indexSteps(graph).map((s) => (
            <span key={s.label}>
              {s.label}: <strong className="font-semibold text-fg">{s.name}</strong>, <span className="font-mono">{s.transform}</span>
            </span>
          ))}
          <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center underline")} onClick={onOpenBuild}>
            Change a step on Build
          </button>
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
          <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center underline")} onClick={onOpenBuild}>
            Change the search settings
          </button>
        </p>
        {replacesUnsaved ? (
          <p data-testid="replaces-unsaved" className="text-xs text-fg-muted">
            Opening it on Build replaces the unsaved pipeline there.
          </p>
        ) : null}
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
  if (row.failed) return "failed"
  if (row.payload) return row.payload.hit ? "found" : "missed"
  return row.started ? "running" : "waiting"
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

const MARK: Record<Verdict, { glyph: string; tone: string }> = {
  found: { glyph: "✓", tone: "bg-kept text-kept-text" },
  missed: { glyph: "✕", tone: "bg-removed text-removed-text shadow-[inset_0_0_0_2px_var(--removed-mark)]" },
  failed: { glyph: "", tone: "bg-removed text-removed-mark" },
  waiting: { glyph: "", tone: "border border-hairline bg-surface text-fg-muted" },
  running: { glyph: "", tone: "border border-fg-muted bg-surface text-fg-muted" },
  notrun: { glyph: "", tone: "border border-hairline bg-surface text-fg-muted" },
}

/** The words a mark's accessible name ends with. */
const SPOKEN: Record<Verdict, string> = { notrun: "not run", waiting: "waiting", running: "running", found: "found", missed: "missed", failed: "failed" }

/**
 * The icon for a state that is not yet a verdict: an empty circle not run, a
 * clock waiting, a spinner running (still under reduced motion, where the word
 * carries it), an alert failed. Found and missed keep their tick and cross.
 * Decorative: the row's word and the mark's name already say the state.
 */
function StateIcon({ verdict, className }: { verdict: Verdict; className?: string }) {
  const props = { "aria-hidden": true, strokeWidth: 2, className: cn("size-[16px] shrink-0", className) }
  switch (verdict) {
    case "notrun":
      return <Circle data-icon="not-run" {...props} />
    case "waiting":
      return <Clock data-icon="waiting" {...props} />
    case "running":
      return <LoaderCircle data-icon="running" {...props} className={cn(props.className, "icon-spin")} />
    case "failed":
      return <CircleAlert data-icon="failed" {...props} />
    default:
      return null
  }
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
      aria-label={`Question ${n}, ${SPOKEN[verdict]}`}
      onClick={onPress}
      className={cn(
        "grid size-[34px] cursor-pointer place-items-center rounded-[9px] text-[0.9375rem] font-bold transition-transform duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) active:scale-[0.98] motion-reduce:transition-none",
        m.tone,
      )}
    >
      {m.glyph ? <span aria-hidden>{m.glyph}</span> : <StateIcon verdict={verdict} />}
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
  failed: { word: "Failed", tone: "text-removed-mark" },
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
      <span data-verdict="" className={cn("inline-flex items-center gap-1 font-sans font-semibold", verdict.tone)}>
        <StateIcon verdict={verdictKind} />
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
