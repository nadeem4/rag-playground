import { useEffect, useId, useRef, useState, type ReactNode } from "react"

import { api } from "@/api/client"
import type { NodeState } from "@/api/runState"
import type { EvalPayload, Registry, RetrievalResult, SampleQuestion } from "@/api/types"
import { usePayloads } from "@/api/usePayloads"
import { useQuestionSet } from "@/api/useQuestionSet"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { useSampleSha } from "@/api/useSampleSha"
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
  percent,
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
import { inUse, questionsFromSample, questionsFromSet, type Question } from "@/state/goldSet"
import { readStoredGraph, upstreamOfStage, type PipelineGraph } from "@/state/graph"
import { errorHeadline, routeRunError } from "@/state/pipeline"

import { RegistryScreen } from "./Shell"

/**
 * Evaluate: score the pipeline you built on Build against the sample question
 * set, so "did that change help?" has a number behind it.
 *
 * It takes the stored graph, swaps the use case for `eval`, and sweeps the
 * question node over every question, each variant carrying the question and
 * the sentence that answers it. Only the use case changes, so parsing,
 * chunking and indexing come straight from the cache on the second run.
 *
 * The previous evaluation of the session is kept in memory, and every row says
 * how it changed. Nothing is stored between sessions.
 */

export function Evaluate() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  const graph = readStoredGraph(reg.registry)
  const source = graph?.nodes.find((n) => n.stage === "source")
  const sourceSha = String(source?.config.sha ?? "")
  const query = graph?.nodes.find((n) => n.stage === "query")
  const useCase = graph?.nodes.find((n) => n.stage === "use_case")
  if (!graph || !sourceSha || !query || !useCase) {
    return (
      <Blocked title="No pipeline to evaluate">Build a pipeline with a file first, then come back here to score what it finds.</Blocked>
    )
  }
  if (!hasRetriever(graph)) {
    return (
      <Blocked title="This pipeline has no retriever">
        An evaluation scores what retrieval found, so the pipeline needs a Retrieve step. Check the pipeline on Build.
      </Blocked>
    )
  }
  if (!reg.registry.use_case?.eval) {
    return <Blocked title="This server has no eval step">Update the server, or run it from this repository, to score a pipeline here.</Blocked>
  }
  return <Evaluation registry={reg.registry} graph={graph} queryId={query.id} useCaseId={useCase.id} sourceSha={sourceSha} />
}

function Blocked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <EmptyState title={title}>
        {children}{" "}
        <a href="/build" className="text-fg underline">
          Go to Build
        </a>
      </EmptyState>
    </main>
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
}: {
  registry: Registry
  graph: PipelineGraph
  queryId: string
  useCaseId: string
  sourceSha: string
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
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previous, setPrevious] = useState<PreviousEvaluation | null>(readPreviousEvaluation)
  const run = useRun(runId)
  const busy = submitting || (runId !== null && !run.closed)

  // Which set is in use, and whether it belongs to the document on Build.
  const uploaded = useQuestionSet(sourceSha)
  const sampleSha = useSampleSha()
  const which = inUse(sourceSha, sampleSha, uploaded.set)
  const questions: Question[] | null = uploaded.set
    ? questionsFromSet(uploaded.set)
    : uploaded.loading
      ? null
      : sample
        ? questionsFromSample(sample)
        : null

  useEffect(() => {
    let live = true
    api.sampleQuestions().then(
      (qs) => live && setSample(qs),
      (err: unknown) => live && setQuestionsError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [])

  const stateOf = (i: number) => run.variants.find((s) => s.index === i)
  const artifactOf = (i: number, id: string | undefined) => {
    const s = stateOf(i)
    return id && finished(s?.nodes[id]) ? s!.nodes[id].artifact_id : undefined
  }
  const ids = asked.map((_, i) => ({ out: artifactOf(i, useCaseId), result: artifactOf(i, resultNode?.id) }))
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
    ? { byId: Object.fromEntries(rows.map((r) => [r.question.id, r.payload!])), summary }
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
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">Evaluate</h1>
          {/* Wraps rather than truncates, so the bar never pushes the page sideways at phone width. */}
          <p className="text-sm text-fg-muted">
            The pipeline you built, over <span className="font-mono">{filename}</span>
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
        {error || questionsError ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error ?? questionsError}
          </p>
        ) : runId === null ? (
          <>
            <p className="text-sm text-fg-muted">
              {questions
                ? `${questions.length} ${questions.length === 1 ? "question" : "questions"} ready. Press Run evaluation to score this pipeline.`
                : "Loading the questions"}
            </p>
            {previous ? (
              <p data-testid="previous" className="text-sm text-fg-muted">
                The last evaluation in this tab found {previous.summary.hits} of {previous.summary.total}.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p data-testid="summary" className="font-mono text-sm font-medium text-fg">
              {summaryLine(summary, previous?.summary)}
            </p>
            <p data-testid="hit-rate" className="text-sm text-fg-muted">
              Hit rate at {topK} <span className="font-mono font-medium text-fg tabular-nums">{percent(scores.hitRate) ?? "not yet"}</span>
            </p>
            <p className="text-xs text-fg-muted">
              {busy ? `Question ${Math.min(settled + 1, asked.length)} of ${asked.length}.` : `${asked.length} questions, one run each.`}
            </p>
          </>
        )}
        {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
      </div>

      {runId === null ? null : <EvalMetricsDetail metrics={scores} byTag={byTag} topK={topK} rerank={rerankText} />}

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
              <QuestionRow key={row.question.id} row={row} before={previous?.byId[row.question.id]} />
            ))}
          </div>
        )}
      </div>
    </main>
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

function QuestionRow({ row, before }: { row: Row; before?: EvalPayload }) {
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
