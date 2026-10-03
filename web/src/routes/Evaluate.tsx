import { useEffect, useId, useRef, useState, type ReactNode } from "react"

import { api } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { EvalPayload, Registry, RetrievalResult, SampleQuestion } from "@/api/types"
import { useSamples } from "@/api/samples"
import { loadPayload } from "@/api/useArtifact"
import { usePayloads } from "@/api/usePayloads"
import { useQuestionSet } from "@/api/useQuestionSet"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { EmptyState } from "@/components/EmptyState"
import { EvalMetricsDetail } from "@/components/evaluate/EvalMetrics"
import { QuestionSetPanel } from "@/components/evaluate/QuestionSetPanel"
import { CONTROL } from "@/components/fields/types"
import { rowsFromResult } from "@/components/inspectors/hits"
import { RetrievalResultInspector } from "@/components/inspectors/RetrievalResultInspector"
import type { InspectorStatus } from "@/components/inspectors/status"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  changeFor,
  changeText,
  evalGraph,
  hasRetriever,
  isEvalOutput,
  metrics,
  metricsByTag,
  missText,
  percent,
  piecesWarning,
  pipelineSteps,
  questionVariants,
  readPreviousEvaluation,
  rerankEffect,
  rerankLine,
  storePreviousEvaluation,
  summarize,
  summaryLine,
  type PreviousEvaluation,
  type RowChange,
} from "@/state/evaluate"
import { inUse, questionsFromSample, questionsFromSet, sampleFor, type Question } from "@/state/goldSet"
import { readStoredGraph, upstreamOfStage, type PipelineGraph } from "@/state/graph"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
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
  const { pipelines, currentId } = usePipelines()
  const pickerId = useId()
  // null until the picker is used: the default follows Build (I1).
  const [choice, setChoice] = useState<string | null>(null)
  // True while an evaluation runs, so the pipeline under it cannot change (M8).
  const [busy, setBusy] = useState(false)
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  const registry = reg.registry
  // A saved pipeline this server cannot run is listed but treated as absent (M7).
  const usable = new Map(pipelines.map((p) => [p.id, usableGraph(p, registry)]))
  const working = readStoredGraph(registry)
  const current = pipelines.find((p) => p.id === currentId) ?? null
  const currentGraph = current ? usable.get(current.id) : null
  // The current saved pipeline is the default only while Build shows it unedited;
  // otherwise Build's working copy is what "the pipeline on Build" means (I1).
  const unedited = Boolean(currentGraph && working && sameGraph(currentGraph, working))
  const chosenId = choice ?? (unedited ? currentId! : "")
  const chosen = pipelines.find((p) => p.id === chosenId && usable.get(p.id)) ?? null
  const graph = chosen ? usable.get(chosen.id)! : working
  // The working copy of saved pipeline A is scored under A's key, so editing A
  // and scoring it compares against A's last score.
  const pipelineKey = chosen ? chosen.id : (currentId ?? "working")
  const pipelineName = chosen
    ? chosen.name
    : current && currentGraph && !unedited
      ? `${current.name} (edited)`
      : "The pipeline on Build"
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* Outside the keyed body, so switching pipelines keeps this select, and its focus (F5). */}
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1">
        <label htmlFor={pickerId} className="text-sm text-fg-muted">
          Pipeline
        </label>
        <select
          id={pickerId}
          aria-label="Pipeline"
          className={cn(CONTROL, "w-auto")}
          value={chosen ? chosen.id : ""}
          disabled={busy}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">The pipeline on Build</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id} disabled={!usable.get(p.id)}>
              {usable.get(p.id) ? p.name : `${p.name} (not usable here)`}
            </option>
          ))}
        </select>
      </div>
      {/* Keyed by what is scored, not by the score key: an edited A and A share a key but not a graph. */}
      <EvaluateBody
        key={chosen ? chosen.id : "working"}
        graph={graph}
        pipelineKey={pipelineKey}
        pipelineName={pipelineName}
        registry={registry}
        onBusy={setBusy}
      />
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
  pipelineName,
  registry,
  onBusy,
}: {
  graph: PipelineGraph | null
  pipelineKey: string
  pipelineName: string
  registry: Registry
  onBusy: (busy: boolean) => void
}) {
  const source = graph?.nodes.find((n) => n.stage === "source")
  const sourceSha = String(source?.config.sha ?? "")
  const query = graph?.nodes.find((n) => n.stage === "query")
  const useCase = graph?.nodes.find((n) => n.stage === "use_case")
  if (!graph || !sourceSha || !query || !useCase) {
    return (
      <Blocked title="No pipeline to evaluate">
        Build a pipeline with a file first, then come back here to score what it finds.
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
      pipelineName={pipelineName}
      onBusy={onBusy}
    />
  )
}

function Blocked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
  result?: RetrievalResult
  resultStatus: InspectorStatus
  failed?: NodeState
  started: boolean
}

function Evaluation({
  registry,
  graph,
  queryId,
  useCaseId,
  sourceSha,
  pipelineKey,
  pipelineName,
  onBusy,
}: {
  registry: Registry
  graph: PipelineGraph
  queryId: string
  useCaseId: string
  sourceSha: string
  pipelineKey: string
  pipelineName: string
  onBusy: (busy: boolean) => void
}) {
  const topKId = useId()
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
  const run = useRun(runId)
  const busy = submitting || (runId !== null && !run.closed)
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

  const stateOf = (i: number) => run.variants.find((s) => s.index === i)
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
  const warning = piecesWarning(pieces, shownK)
  const payload = usePayloads(ids.flatMap((x) => [x.out, x.result]))

  const rows: Row[] = asked.map((question, i) => {
    const s = stateOf(i)
    const out = payload(ids[i].out).data
    const got = payload(ids[i].result)
    const result = got.data as RetrievalResult | undefined
    return {
      question,
      payload: isEvalOutput(out) ? out.payload : undefined,
      result: result && Array.isArray(result.hits) ? result : undefined,
      resultStatus: got.status,
      failed: s ? Object.values(s.nodes).find((n) => n.status === "failed") : undefined,
      started: s !== undefined,
    }
  })

  const summary = summarize(rows.map((r) => r.payload))
  const scores = metrics(rows.map((r) => r.payload))
  const byTag = metricsByTag(rows.map((r) => ({ tags: r.question.tags, payload: r.payload })))
  const effect = graph.nodes.some((n) => n.stage === "rerank")
    ? rerankEffect(rows.map((r) => ({ payload: r.payload, rows: r.result ? rowsFromResult(r.result) : undefined })))
    : null
  const rerankText = effect ? rerankLine(effect) : null
  const settled = rows.filter((r) => r.payload || r.failed).length
  const firstFailure = rows.find((r) => r.failed)?.failed
  const steps = pipelineSteps(graph)
  const filename = String(graph.nodes.find((n) => n.stage === "source")?.config.filename ?? "")

  // The finished evaluation on screen, to compare the next one against. It is
  // written to session storage as soon as it finishes, because changing a
  // setting means a trip to Build and a fresh page.
  const done = runId !== null && run.closed && rows.length > 0 && rows.every((r) => r.payload !== undefined)
  const finishedRun: PreviousEvaluation | null = done
    ? { sourceSha, pipelineKey, byId: Object.fromEntries(rows.map((r) => [r.question.id, r.payload!])), summary }
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
    const before = finishedRun
    try {
      const g = evalGraph(graph, registry, topK)
      if (!g) throw new Error("This server has no eval step.")
      const { run_id } = await api.createSweep({
        graph: g,
        node_id: queryId,
        variants: questionVariants(query, questions),
        through: useCaseId,
      })
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">Evaluate</h1>
          {/* Wraps rather than truncates, so the bar never pushes the page sideways at phone width. */}
          <p className="text-sm text-fg-muted">
            {pipelineName}, over <span className="font-mono">{filename}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={topKId} className="text-sm text-fg-muted">
            Top k
          </label>
          <input
            id={topKId}
            type="number"
            min={1}
            value={topK}
            disabled={busy}
            onChange={(e) => setTopK(Math.max(1, Math.round(Number(e.target.value)) || 1))}
            className={cn(CONTROL, "w-[72px]")}
          />
          {busy && runId ? (
            <Button variant="outline" size="sm" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || !questions?.length} onClick={() => void evaluate()}>
            {busy ? "Evaluating" : runId ? "Evaluate again" : "Run evaluation"}
          </Button>
        </div>
      </div>

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
      />

      <p className="shrink-0 border-b border-hairline px-3 py-1 text-xs text-fg-muted">
        Evaluating{" "}
        {steps.map((s, i) => (
          <span key={s.label}>
            {i > 0 ? ", " : ""}
            {s.label} <span className="font-mono text-fg">{s.transform}</span>
          </span>
        ))}
        . A question counts as found when one of the top {topK} pieces contains the sentence that answers it.{" "}
        <a href="/build" className="text-fg underline">
          Change a setting on Build
        </a>{" "}
        and run this again to see what it did.
      </p>

      <div className="flex min-h-[40px] shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hairline px-3 py-2" aria-live="polite">
        {error || questionsError || samplesError ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error ?? questionsError ?? samplesError}
          </p>
        ) : runId === null ? (
          <>
            <p className="text-sm text-fg-muted">
              {questions
                ? `${questions.length} ${questions.length === 1 ? "question" : "questions"} ready. Press Run evaluation to score this pipeline.`
                : noBundledSet
                  ? "No question set for this document. Upload one to evaluate it."
                  : "Loading the questions"}
            </p>
            {previous ? (
              <p data-testid="previous" className="text-sm text-fg-muted">
                The last evaluation in this tab found {previous.summary.hits} of {previous.summary.total}.
              </p>
            ) : null}
          </>
        ) : busy ? (
          <p className="text-sm font-medium text-fg">{`Scoring question ${Math.min(settled + 1, asked.length)} of ${asked.length}.`}</p>
        ) : (
          <>
            <p data-testid="summary" className="text-sm font-medium text-fg">
              <MonoNumbers text={summaryLine(summary, previous?.summary)} />
            </p>
            <p data-testid="hit-rate" className="text-sm text-fg-muted">
              Hit rate at {shownK} <span className="font-mono font-medium text-fg tabular-nums">{percent(scores.hitRate) ?? "not yet"}</span>
            </p>
            <p className="text-xs text-fg-muted">{`${asked.length} questions, one run each.`}</p>
          </>
        )}
        {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
      </div>

      {warning ? (
        <p role="status" data-testid="pieces-warning" className="shrink-0 border-b border-hairline px-3 py-1 text-xs text-fg-muted">
          {warning}
        </p>
      ) : null}

      {runId === null ? null : <EvalMetricsDetail metrics={scores} byTag={byTag} topK={shownK} rerank={rerankText} />}

      {firstFailure ? (
        <p role="alert" className="shrink-0 border-b border-hairline px-3 py-2 font-mono text-xs break-words text-danger">
          {errorHeadline(firstFailure.error ?? "A step failed.")}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {runId === null ? (
          <EmptyState title="Nothing scored yet">
            Every question runs the whole pipeline once. The steps above the question are shared, so they run once and the rest come from the
            cache.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-px bg-hairline">
            <div className="grid grid-cols-[52px_44px_minmax(0,1fr)] items-baseline gap-x-2 bg-surface-elevated px-3 py-1" aria-hidden>
              <span className="meta">result</span>
              <span className="meta text-right">rank</span>
              <span className="meta">question</span>
            </div>
            {rows.map((row) => (
              <QuestionRow key={row.question.id} row={row} before={previous?.byId[row.question.id]} topK={shownK} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Improvements read on the kept hue, regressions on the removed one. */
const CHANGE_RULE: Record<RowChange, string> = {
  none: "",
  found: "border-l-2 border-kept-mark",
  up: "border-l-2 border-kept-mark",
  lost: "border-l-2 border-removed-mark",
  down: "border-l-2 border-removed-mark",
}

function QuestionRow({ row, before, topK }: { row: Row; before?: EvalPayload; topK: number }) {
  const p = row.payload
  const change = changeFor(p, before)
  const moved = changeText(change, before)
  const verdict = !row.started ? "waiting" : row.failed ? "failed" : p ? (p.hit ? "hit" : "miss") : "running"
  const tone =
    verdict === "hit"
      ? "bg-kept text-kept-text"
      : verdict === "miss"
        ? "bg-removed text-removed-text"
        : verdict === "failed"
          ? "bg-removed text-danger"
          : "text-fg-muted"

  return (
    <details className={cn("bg-surface", CHANGE_RULE[change])} data-question={row.question.id} data-change={change === "none" ? undefined : change}>
      <summary className="grid cursor-pointer list-none grid-cols-[52px_44px_minmax(0,1fr)] items-baseline gap-x-2 px-3 py-2 hover:bg-muted">
        <span className={cn("justify-self-start rounded-control px-1 font-mono text-2xs", tone)}>{verdict}</span>
        <span className="text-right font-mono text-sm text-fg tabular-nums">{p?.rank ?? ""}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-fg">{row.question.question}</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs text-fg-muted">
            {p?.hit && p.match !== "exact" ? <span>{p.match} match</span> : null}
            {p?.matched_chunk_id ? <span title={p.matched_chunk_id}>{p.matched_chunk_id.slice(0, 8)}</span> : null}
            {p ? (
              <span>
                {p.considered} of {p.total_candidates} checked
              </span>
            ) : null}
            {p && !p.hit ? <span>{missText(p, topK)}</span> : null}
            {moved ? <span className="font-medium text-fg">{moved}</span> : null}
            {row.failed ? <span className="text-danger">{errorHeadline(row.failed.error ?? "Failed")}</span> : null}
          </span>
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-hairline">
        <RetrievalResultInspector result={row.result} status={row.resultStatus} showDetail={false} />
      </div>
    </details>
  )
}
