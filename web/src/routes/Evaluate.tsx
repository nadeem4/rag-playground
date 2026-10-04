import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

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
import { EvidenceSlip, LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { ordinal, rowsFromResult, scoreKey, type FindingPart } from "@/components/inspectors/hits"
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
  piecesWarning,
  pipelineSteps,
  questionVariants,
  readPreviousEvaluation,
  reasonText,
  rerankEffect,
  rerankLine,
  storePreviousEvaluation,
  scoreFinding,
  summarize,
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
  // The header's slot for the body's two controls: set by the slot's ref callback.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
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
      : "the pipeline on Build"
  const filename = String(graph?.nodes.find((n) => n.stage === "source")?.config.filename ?? "")
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
      <div className="flex flex-col gap-5 px-4 pt-4 pb-8 md:px-6">
        <header data-testid="evaluate-header" className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold">Evaluate</h1>
            {filename ? (
              <p className="text-sm text-fg-muted">
                How often {pipelineName} finds the answer in <span className="font-mono break-all text-fg">{filename}</span>.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-2.5">
            {/* Outside the keyed body, so switching pipelines keeps this select, and its focus (F5). */}
            <div className="flex flex-col gap-1">
              <label htmlFor={pickerId} className="text-xs font-semibold text-fg-muted">
                Pipeline
              </label>
              <select
                id={pickerId}
                aria-label="Pipeline"
                className={cn(CONTROL, "w-auto max-w-full")}
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
            {/* The body renders Pieces checked and the run button here, through a portal. */}
            <div ref={setSlot} className="flex flex-wrap items-end gap-2.5" />
          </div>
        </header>
        {/* Keyed by what is scored, not by the score key: an edited A and A share a key but not a graph. */}
        <EvaluateBody
          key={chosen ? chosen.id : "working"}
          graph={graph}
          pipelineKey={pipelineKey}
          registry={registry}
          onBusy={setBusy}
          slot={slot}
        />
      </div>
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
}: {
  graph: PipelineGraph | null
  pipelineKey: string
  registry: Registry
  onBusy: (busy: boolean) => void
  slot: HTMLElement | null
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
      onBusy={onBusy}
      slot={slot}
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
  onBusy,
  slot,
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
  const misses = rows.flatMap((r) => (r.payload && !r.payload.hit ? [r.payload] : []))
  const warning = piecesWarning(pieces, shownK, misses)
  const score = scoreFinding(
    summary,
    previous,
    rows.map((r) => ({ now: r.payload, before: previous?.byId[r.question.id] })),
    steps,
    shownK,
  )

  // Each row's <details>, so a mark can open its row and bring it into view.
  const rowEls = useRef(new Map<string, HTMLDetailsElement>())
  function openRow(id: string) {
    const el = rowEls.current.get(id)
    if (!el) return
    el.open = true
    el.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
  }

  // The finished evaluation on screen, to compare the next one against. It is
  // written to session storage as soon as it finishes, because changing a
  // setting means a trip to Build and a fresh page.
  const done = runId !== null && run.closed && rows.length > 0 && rows.every((r) => r.payload !== undefined)
  const finishedRun: PreviousEvaluation | null = done
    ? { sourceSha, pipelineKey, byId: Object.fromEntries(rows.map((r) => [r.question.id, r.payload!])), summary, steps }
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

  const controls = (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={topKId} className="text-xs font-semibold text-fg-muted">
          Pieces checked
        </label>
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
        <Button variant="outline" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
          Cancel
        </Button>
      ) : null}
      <Button disabled={busy || !questions?.length} onClick={() => void evaluate()}>
        {busy ? "Evaluating" : runId ? "Evaluate again" : "Evaluate"}
      </Button>
    </>
  )

  return (
    <div className="flex flex-col gap-5">
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
        />
        {/* The recipe in one line: each step by its plain name, beside its code name. */}
        <p data-testid="recipe-line" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          {steps.map((s) => (
            <span key={s.label}>
              {s.label}: <strong className="font-semibold text-fg">{s.name}</strong>, <span className="font-mono">{s.transform}</span>
            </span>
          ))}
          <a href="/build" className="inline-flex items-center text-primary underline underline-offset-4">
            Change a step on Build
          </a>
        </p>
      </div>

      <section aria-label="Score" aria-live="polite" className="flex flex-col gap-2.5">
        {error || questionsError || samplesError ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error ?? questionsError ?? samplesError}
          </p>
        ) : runId === null ? (
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
        ) : (
          <>
            {busy ? null : (
              <div className="flex flex-col gap-1.5">
                <p data-testid="summary" className="max-w-[52ch] text-[1.375rem] leading-snug text-balance text-fg">
                  <MonoNumbers text={score.finding} />
                </p>
                <p data-testid="hit-rate" className="max-w-[70ch] text-fg-muted">
                  <MonoNumbers text={score.sub} />
                </p>
              </div>
            )}
            <div role="list" aria-label="One mark per question" className="flex flex-wrap gap-1.5">
              {rows.map((row, i) => (
                <span role="listitem" key={row.question.id} className="flex">
                  <Mark n={i + 1} verdict={verdictOf(row)} onPress={() => openRow(row.question.id)} />
                </span>
              ))}
            </div>
            {busy ? (
              <p className="text-xs text-fg-muted">{`Scoring question ${Math.min(settled + 1, asked.length)} of ${asked.length}.`}</p>
            ) : null}
          </>
        )}
        {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}

        {warning ? (
          <p role="status" data-testid="pieces-warning" className="max-w-[80ch] rounded-panel bg-warn px-3 py-2 text-sm text-warn-text">
            {warning}
          </p>
        ) : null}

        {runId === null ? null : <EvalMetricsDetail metrics={scores} byTag={byTag} topK={shownK} rerank={rerankText} />}
      </section>

      {firstFailure ? (
        <p role="alert" className="font-mono text-xs break-words text-danger">
          {errorHeadline(firstFailure.error ?? "A step failed.")}
        </p>
      ) : null}

      <div>
        {runId === null ? (
          <EmptyState title="Nothing scored yet">
            Every question runs the whole pipeline once. The steps above the question are shared, so they run once and the rest come from the
            cache.
          </EmptyState>
        ) : (
          <section aria-labelledby={questionsId} className="flex flex-col gap-2">
            <h2 id={questionsId} className="text-base font-semibold">
              Questions
            </h2>
            <div className="border-t border-hairline">
              {rows.map((row) => (
                <QuestionRow
                  key={row.question.id}
                  row={row}
                  before={previous?.byId[row.question.id]}
                  topK={shownK}
                  rowRef={(el) => {
                    if (el) rowEls.current.set(row.question.id, el)
                    else rowEls.current.delete(row.question.id)
                  }}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

type Verdict = "waiting" | "running" | "found" | "missed" | "failed"

function verdictOf(row: Row): Verdict {
  if (!row.started) return "waiting"
  if (row.failed) return "failed"
  if (!row.payload) return "running"
  return row.payload.hit ? "found" : "missed"
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

const MARK: Record<Verdict, { glyph: string; tone: string }> = {
  found: { glyph: "\u2713", tone: "bg-kept text-kept-text" },
  missed: { glyph: "\u2715", tone: "bg-removed text-removed-text shadow-[inset_0_0_0_2px_var(--removed-mark)]" },
  failed: { glyph: "!", tone: "bg-removed text-danger" },
  waiting: { glyph: "", tone: "border border-hairline bg-surface text-fg-muted" },
  running: { glyph: "", tone: "border border-fg-muted bg-surface text-fg-muted" },
}

/**
 * One question as a mark: a tick for found, a cross with a ring for missed, a
 * neutral outline while it waits or runs. 34 px square; a coarse pointer
 * grows it to 44 px through the touch rule in tokens.css. Pressing it opens
 * the question's row.
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
  found: { word: "\u2713 Found", tone: "text-kept-text" },
  missed: { word: "\u2715 Missed", tone: "text-removed-text" },
  failed: { word: "Failed", tone: "text-danger" },
  waiting: { word: "Waiting", tone: "text-fg-muted" },
  running: { word: "Running", tone: "text-fg-muted" },
}

/**
 * One question: the verdict in a word, the question, the change since the
 * last run on the right, and the reason in a sentence under the question.
 * A <details>, so the keyboard and a mark both open it through `open`.
 */
function QuestionRow({
  row,
  before,
  topK,
  rowRef,
}: {
  row: Row
  before?: EvalPayload
  topK: number
  rowRef?: (el: HTMLDetailsElement | null) => void
}) {
  const p = row.payload
  const change = changeFor(p, before)
  const moved = changeText(change, before)
  const verdict = VERDICT[verdictOf(row)]
  const reason = row.failed ? errorHeadline(row.failed.error ?? "Failed") : p ? reasonText(p, topK) : null

  return (
    <details
      ref={rowRef}
      className="border-b border-hairline"
      data-question={row.question.id}
      data-change={change === "none" ? undefined : change}
    >
      <summary className="grid cursor-pointer list-none grid-cols-1 items-baseline gap-x-3.5 gap-y-1 rounded-panel px-2 py-3 hover:bg-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring) md:grid-cols-[92px_minmax(0,1fr)_auto]">
        <span data-verdict="" className={cn("font-sans font-semibold", verdict.tone)}>
          {verdict.word}
        </span>
        <span data-question-text="" className="text-base font-semibold text-fg">
          {row.question.question}
        </span>
        {moved ? (
          <span data-row-change="" className={cn("text-[0.8125rem] font-semibold whitespace-nowrap", CHANGE_TONE[change])}>
            {moved}
          </span>
        ) : (
          <span aria-hidden className="hidden md:block" />
        )}
        {reason ? (
          <span data-reason="" className={cn("font-sans text-sm md:col-start-2", row.failed ? "break-words text-danger" : "text-fg-muted")}>
            <MonoNumbers text={reason} />
          </span>
        ) : null}
      </summary>
      <OpenRow row={row} />
    </details>
  )
}

/** The slips shown before Show all. */
const TOP = 3

/**
 * An open row: the sentence that answers the question, then what came back as
 * evidence slips, the top three first. The matched piece says it holds the
 * answer. Capped at 72ch, so the passages read as text.
 */
function OpenRow({ row }: { row: Row }) {
  const [all, setAll] = useState(false)
  const gold = row.question.gold_answers[0]
  const hits = row.result ? rowsFromResult(row.result) : []
  const shown = all ? hits : hits.slice(0, TOP)
  const scale = scoreKey(hits)
  const matched = row.payload?.hit ? row.payload.matched_chunk_id : null
  const holds = (rank: number): FindingPart[] => [{ text: ordinal(rank), place: true }, { text: ", holds the answer" }]
  return (
    <div data-open-row="" className="flex max-w-[72ch] flex-col gap-3 px-2 pb-4 md:pl-[114px]">
      {gold ? (
        <div className="border-l-[3px] border-primary py-0.5 pl-3">
          <p className="text-xs text-fg-muted">The sentence that answers it</p>
          <p className="font-serif text-base leading-[1.55] break-words text-fg">{gold}</p>
        </div>
      ) : null}
      {row.result ? (
        hits.length ? (
          <>
            <p className="text-sm text-fg-muted">
              {hits.length > TOP ? `What came back, top ${TOP} of ${hits.length}.` : `What came back, ${hits.length} ${hits.length === 1 ? "piece" : "pieces"}.`}
            </p>
            <div role="list" className="flex flex-col gap-2.5">
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
    </div>
  )
}
