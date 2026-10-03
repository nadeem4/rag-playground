import { useEffect, useMemo, useState } from "react"

import { hasAnyKey, type Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { useSampleQuestions, useSamples } from "@/api/samples"
import type { LlmSettings, Registry } from "@/api/types"
import { useArtifactPayload } from "@/api/useArtifact"
import type { ExplainState } from "@/api/useExplain"
import { KeyHint } from "@/components/ApiKeyControl"
import { blockingNode, type NodeErrors } from "@/components/pipeline/PipelineColumn"
import { QuestionField } from "@/components/pipeline/QuestionField"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ASK_STAGES, askNodes, indexNode, infoFor, terminalNode, titleFor, upstreamOfStage, type PipelineGraph } from "@/state/graph"

import { AskResults, finalRows, fresh, rerankLabel, useAskOutputs } from "./AskResults"
import { AskSettings, RETRIEVAL_LABEL } from "./AskSettings"
import { askSignature, goldRank, Transcript, type AskSnapshot, type TranscriptEntry } from "./Transcript"

/**
 * The Ask panel: the right pane when no card is selected. It holds the
 * question and the retrieval, rerank and answer settings, which are the
 * query, retrieve, rerank and use case nodes of the same pipeline graph.
 */

export interface AskPanelProps {
  graph: PipelineGraph
  registry: Registry
  results: Record<string, NodeState>
  stale: Set<string>
  busy: boolean
  /** An Ask run is in flight: only then does Ask read Asking. */
  asking?: boolean
  keys: Keys
  server: LlmSettings | null
  explanations?: Record<string, ExplainState>
  errors: Record<string, NodeErrors>
  /** Set when a keyless ask stopped before Chat and the run has ended. */
  keyNotice: string | null
  /**
   * The Ask run that has just finished, once it has, with what it was asked
   * with: its answer joins the transcript under those labels.
   */
  asked: AskSnapshot | null
  transcript: TranscriptEntry[]
  /** The rerank result whose comparison the reader hid. Build holds it, so it outlives the panel. */
  comparisonHidden: string | null
  /** Set when an Ask could not start or its run crashed: the note above the cards has the detail. */
  runError?: string | null
  onComparison: (hidden: string | null) => void
  onLog: (entry: TranscriptEntry) => void
  onConfig: (id: string, config: Record<string, unknown>) => void
  onTransform: (id: string, transform: string) => void
  onReranker: (transform: string | null) => void
  onUseCase: (transform: "search" | "chat") => void
  onAsk: () => void
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `Hybrid (RRF), top 20 candidates. Rerank: MMR, keep 5. Answer: Search.` */
export function recipeLine(graph: PipelineGraph, registry: Registry): string {
  const { retrieve, rerank, useCase } = askNodes(graph)
  const parts: string[] = []
  if (retrieve) {
    const label = RETRIEVAL_LABEL[retrieve.transform] ?? retrieve.transform
    parts.push(typeof retrieve.config.top_k === "number" ? `${label}, top ${retrieve.config.top_k} candidates.` : `${label}.`)
  }
  if (rerank) {
    const label = rerankLabel(rerank.transform)
    parts.push(typeof rerank.config.top_k === "number" ? `Rerank: ${label}, keep ${rerank.config.top_k}.` : `Rerank: ${label}.`)
  } else {
    parts.push("Rerank: none.")
  }
  if (useCase?.transform === "chat") {
    const model = String(useCase.config.model ?? "")
    const labels = infoFor(registry, useCase)?.config_schema.properties?.model?.["x-labels"] as Record<string, string> | undefined
    parts.push(`Answer: Chat with ${labels?.[model] ?? model}.`)
  } else if (useCase) {
    parts.push(`Answer: ${titleFor(useCase)}.`)
  }
  return parts.join(" ")
}

export function AskPanel(p: AskPanelProps) {
  const { query, retrieve, rerank, useCase } = askNodes(p.graph)
  const index = indexNode(p.graph)
  const indexId = index?.stage === "index" ? fresh(p.results, p.stale, index) : undefined
  const indexPayload = useArtifactPayload(indexId)
  const pieces = (indexPayload.data as { doc_count?: unknown } | undefined)?.doc_count

  // Pages come from the samples list; an upload reads them from the parsed document.
  const source = p.graph.nodes.find((n) => n.stage === "source")
  const sha = source?.config.sha ? String(source.config.sha) : undefined
  const filename = String(source?.config.filename ?? "")
  const samples = useSamples()
  const sample = sha ? samples.samples?.find((s) => s.sha === sha) : undefined
  const samplesAnswered = samples.samples !== null || samples.error !== null
  const docNode = index ? upstreamOfStage(p.graph, index.id, ["clean", "parse"]) : undefined
  const docId = indexId && samplesAnswered && !sample ? fresh(p.results, p.stale, docNode) : undefined
  const docPayload = useArtifactPayload(docId)
  const pages = sample?.pages ?? (docPayload.data as { page_count?: unknown } | undefined)?.page_count

  const questions = useSampleQuestions(sample?.name)
  const terminal = terminalNode(p.graph)
  const blocker = terminal ? blockingNode(p.graph, p.registry, p.explanations, terminal.id) : undefined
  const askDisabled = p.busy || !indexId || Boolean(blocker)

  // Open on a pipeline whose question has not run yet; folded once it has.
  const answered = p.graph.nodes.some((n) => ASK_STAGES.includes(n.stage) && n.stage !== "query" && p.results[n.id])
  const [open, setOpen] = useState(!answered)
  // A server error on a settings step must be seen, so it unfolds the settings.
  const settingsError = [retrieve, rerank, useCase].some((n) => n && p.errors[n.id])
  const shown = open || settingsError

  function ask() {
    setOpen(false)
    p.onAsk()
  }

  // One transcript entry per finished Ask, found at the gold's rank when the question is the sample's.
  const outputs = useAskOutputs(p.graph, p.results, p.stale)
  // The memo reads exactly what it lists: the three payloads and whether a reranker is in the graph.
  const reranked = Boolean(rerank)
  const { rerank: rerankOut, output, retrieve: retrieveOut } = outputs
  const rows = useMemo(
    () => finalRows({ rerank: rerankOut, output, retrieve: retrieveOut }, reranked),
    [rerankOut, output, retrieveOut, reranked],
  )
  // The settings now, against the snapshot taken when Ask was pressed: a change in between
  // means the rows on screen are not that run's, so the run is not logged at all.
  const current = askSignature(p.graph, p.registry)
  const { onLog, asked: snap, transcript } = p
  useEffect(() => {
    if (!snap) return
    // A logged run is frozen: its own question and pieces are read again, never the current settings.
    const logged = transcript.find((e) => e.runId === snap.runId)
    const entry: TranscriptEntry | null =
      logged ??
      (rows && current === snap.signature
        ? {
            runId: snap.runId,
            question: snap.question,
            pipeline: snap.pipeline,
            reranker: snap.reranker,
            rows: rows.map((r) => ({ rank: r.rank, text: r.text })),
            found: null,
          }
        : null)
    if (!entry || entry.found !== null) return
    const sampleQ = questions.find((q) => q.question.trim() === entry.question.trim())
    const found = sampleQ ? goldRank(entry.rows, [sampleQ.gold_answer, ...(sampleQ.gold_answers ?? [])]) : null
    if (logged && found === null) return
    onLog({ ...entry, found })
  }, [snap, transcript, rows, questions, current, onLog])

  // A result on an Ask step that the settings have moved past: the lists are gone until the next Ask.
  const askStale = !p.busy && [query, retrieve, rerank, useCase].some((n) => n !== undefined && p.results[n.id] !== undefined && p.stale.has(n.id))

  const queryErrors = query ? p.errors[query.id] : undefined
  const setText = (text: string) => {
    if (query) p.onConfig(query.id, { ...query.config, text })
  }

  const ready = [
    filename,
    typeof pages === "number" ? plural(pages, "page", "pages") : null,
    typeof pieces === "number" ? plural(pieces, "piece", "pieces") : null,
  ].filter(Boolean)

  return (
    <section aria-label="Ask panel" className="flex min-w-0 flex-col md:min-h-0">
      <div className="flex min-h-row shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-3 py-1">
        <h2 className="text-xl font-semibold">Ask</h2>
        <span data-testid="index-status" className="text-xs text-fg-muted">
          {indexId
            ? `Index ready: ${ready.join(", ")}`
            : sha
              ? "Build the index first."
              : "Load a PDF or pick a sample on the Upload card, then build the index."}
        </span>
      </div>
      {/* Scrolls on its own from md up; below it the whole page is one scroll. */}
      <div className="flex flex-col gap-3 p-3 md:min-h-0 md:flex-1 md:overflow-y-auto">
        {query ? (
          <QuestionField
            value={String(query.config.text ?? "")}
            errors={queryErrors?.fields?.text}
            disabled={askDisabled}
            onChange={setText}
            onSubmit={ask}
            action={
              <Button size="sm" busy={p.asking} disabled={askDisabled} onClick={ask}>
                {p.asking ? "Asking" : "Ask"}
              </Button>
            }
          />
        ) : null}
        {queryErrors?.message ? <p className="text-xs break-words text-danger">{queryErrors.message}</p> : null}
        {indexId && blocker ? <p className="text-xs text-danger">Fix the {titleFor(blocker)} settings to ask.</p> : null}
        {p.runError ? (
          <p role="alert" data-testid="ask-run-error" className="text-xs text-danger">
            {p.runError}
          </p>
        ) : null}
        {p.keyNotice ? (
          // A div, not a p: KeyHint is itself a p, and a p cannot hold one.
          <div role="status" data-testid="key-notice" className="text-xs text-fg-muted">
            <p>{p.keyNotice}</p>
            <KeyHint />
          </div>
        ) : null}
        {questions.length ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-fg-muted">Try one of the sample's questions:</p>
            <div className="flex flex-wrap gap-1">
              {questions.map((q) => (
                <Button
                  key={q.id}
                  variant="outline"
                  // No size: the sm size's fixed 28px height (h-row-compact) would win over h-auto, and a wrapped
                  // question would spill over the chip below. The chip grows with its text instead.
                  size={null}
                  // Wraps and shrinks, so a long question never pushes the pane sideways on a phone.
                  className="chip min-h-[24px] max-w-full shrink px-2 py-1 text-left text-xs whitespace-normal"
                  onClick={() => setText(q.question)}
                >
                  {q.question}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-fg-muted">Recipe</span>
            <p data-testid="recipe" className="text-sm">
              {recipeLine(p.graph, p.registry)}
            </p>
          </div>
          {/* Not disabled while an error shows: the label stays honest and the title says why it will not fold. */}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={shown}
            aria-disabled={settingsError || undefined}
            title={settingsError ? "Fix the error below first." : undefined}
            className={cn(settingsError && "cursor-not-allowed opacity-50")}
            onClick={() => {
              if (!settingsError) setOpen((o) => !o)
            }}
          >
            {shown ? "Hide settings" : "Change settings"}
          </Button>
        </div>
        {shown ? (
          <AskSettings
            graph={p.graph}
            registry={p.registry}
            hasKey={hasAnyKey(p.server, p.keys)}
            errors={p.errors}
            onConfig={p.onConfig}
            onTransform={p.onTransform}
            onReranker={p.onReranker}
            onUseCase={p.onUseCase}
          />
        ) : null}
        <AskResults
          graph={p.graph}
          registry={p.registry}
          outputs={outputs}
          comparisonHidden={p.comparisonHidden}
          stale={askStale}
          questions={questions}
          onComparison={p.onComparison}
        />
        <Transcript entries={p.transcript} onAskAgain={setText} />
      </div>
    </section>
  )
}
