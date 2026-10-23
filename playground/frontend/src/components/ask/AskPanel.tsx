import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { hasAnyKey, keyNeedFor, PROVIDER_INFO, useApiKey, type Keys } from "@/api/apiKey"
import { QUEUED_LINE } from "@/api/runState"
import type { NodeState } from "@/api/runState"
import { useSampleQuestions, useSamples } from "@/api/samples"
import type { ChunkSet, GraphNode, LlmProvider, LlmSettings, Registry } from "@/api/types"
import { useArtifactPayload } from "@/api/useArtifact"
import type { ExplainState } from "@/api/useExplain"
import { KeyHint } from "@/components/ApiKeyControl"
import { FileDot } from "@/components/FileTag"
import { blockingNode, type NodeErrors } from "@/components/pipeline/PipelineColumn"
import { QuestionField } from "@/components/pipeline/QuestionField"
import { useElapsed } from "@/components/pipeline/useElapsed"
import { Button } from "@/components/ui/button"
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { fileOf, type FileInfo } from "@/lib/files"
import { cn } from "@/lib/utils"
import { documentsOf } from "@/state/document"
import { ASK_STAGES, askNodes, indexNode, infoFor, rewriteOf, terminalNode, titleFor, upstreamOfStage, type PipelineGraph, type RewriteMode } from "@/state/graph"

import { AskResults, finalRows, fresh, rerankLabel, SearchedFor, useAskOutputs } from "./AskResults"
import { AskSettings, CHAT_REASON, RETRIEVAL_LABEL } from "./AskSettings"
import { askSignature, findGold, goldsOf, Transcript, type AskSnapshot, type TranscriptEntry } from "./Transcript"

/**
 * The Ask panel, docked at the edge of Build (a bottom sheet on a phone). It holds the
 * question and the retrieval, rerank and answer settings, which are the
 * query, retrieve, rerank and use case nodes of the same pipeline graph.
 */

/** What the Ask button does, for its tooltip. */
const ASK_TITLE = "Runs retrieval, reranking and the answer on the built index, with the settings below."

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
  /** The provider whose key the notice asks for, when it is known. */
  keyProvider?: LlmProvider | null
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
  onRewrite: (mode: RewriteMode) => void
  /** Open Compare on a node: the Retrieval block's Compare searches. */
  onSweep?: (id: string) => void
  onAsk: () => void
  /** The bar's document is missing or not chosen: Ask cannot run until there is one. */
  needsDocument?: boolean
  /** Set while Build the index runs: the step it is on (when one has started) and when that step started, epoch seconds. */
  buildingStep?: { title?: string; startedAt?: number }
  /** True while the run (an Ask or a build) waits its turn on the busy demo. */
  queued?: boolean
  /** The dock's buttons (side switch and close), shown at the end of the panel's head. */
  head?: ReactNode
  /** Search in, with several documents: the one document Ask searches, by sha, or null for all of them. */
  searchIn?: string | null
  onSearchIn?: (sha: string | null) => void
  /** Where the results on show were searched: a document's sha, null for all of them, undefined when not known. */
  askedIn?: string | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How the recipe line names a rewrite, after the retrieval part. */
const REWRITE_SUFFIX: Record<RewriteMode, string> = { none: "", prf: ", rewritten by PRF", llm: ", rewritten by the model" }

/** `Hybrid (RRF), top 20 candidates, rewritten by PRF. Rerank: MMR, keep 5. Answer: Search.` */
export function recipeLine(graph: PipelineGraph, registry: Registry): string {
  const { retrieve, rerank, useCase } = askNodes(graph)
  const parts: string[] = []
  if (retrieve) {
    const label = RETRIEVAL_LABEL[retrieve.transform] ?? retrieve.transform
    const rewrite = REWRITE_SUFFIX[rewriteOf(graph)]
    parts.push(typeof retrieve.config.top_k === "number" ? `${label}, top ${retrieve.config.top_k} candidates${rewrite}.` : `${label}${rewrite}.`)
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

/**
 * Search in, with several documents: all of them, or one file. One file sends
 * `where: {document: [sha]}` with the next Ask.
 */
function SearchIn({ files, value, onChange }: { files: readonly FileInfo[]; value: string | null; onChange: (sha: string | null) => void }) {
  const pill = (on: boolean) =>
    cn(
      "inline-flex min-h-[28px] max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border px-3 text-xs text-fg transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)",
      on ? "border-primary bg-accent-wash" : "border-hairline bg-surface-raised hover:bg-surface-hover",
    )
  return (
    <div role="group" aria-labelledby="search-in" className="flex flex-wrap items-center gap-2">
      <span id="search-in" className="text-xs font-medium">
        Search in
      </span>
      <button type="button" aria-pressed={value === null} className={pill(value === null)} onClick={() => onChange(null)}>
        {`All ${files.length} documents`}
      </button>
      {files.map((f) => (
        <button key={f.sha} type="button" aria-pressed={value === f.sha} className={pill(value === f.sha)} onClick={() => onChange(f.sha)}>
          <FileDot slot={f.slot} />
          <span className="truncate">{f.filename}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Search or Chat, above the question, with one muted line that says what the
 * choice means: the missing key, what Search costs, or which model Chat uses.
 */
function AnswerMode({ useCase, registry, hasKey, onUseCase, onChangeModel }: {
  useCase: GraphNode
  registry: Registry
  hasKey: boolean | null
  onUseCase: (transform: "search" | "chat") => void
  onChangeModel: () => void
}) {
  const { setPanelOpen } = useApiKey()
  const chatInfo = registry.use_case?.chat
  const chatOff = hasKey === false
  const options: SegmentedOption[] = [{ value: "search", label: "Search" }]
  if (chatInfo) options.push({ value: "chat", label: "Chat with a model", disabled: chatOff, title: chatOff ? CHAT_REASON : undefined })
  const chat = useCase.transform === "chat"
  const schema = chatInfo?.config_schema.properties?.model as Record<string, unknown> | undefined
  const model = String(useCase.config.model ?? schema?.default ?? "")
  const need = keyNeedFor(schema, useCase.config.model)
  const whose = need.kind === "provider" ? `, your ${PROVIDER_INFO[need.provider].name} key` : need.kind === "none" ? ", your endpoint" : ""
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <SegmentedControl label="Answer with" options={options} value={useCase.transform} onChange={(v) => onUseCase(v as "search" | "chat")} />
      <p data-testid="answer-mode-line" className="m-0 text-xs text-fg-muted">
        {chat ? (
          <>
            Model <span className="font-mono">{model}</span>
            {whose}{" "}
            <button type="button" className={LINK_BUTTON} onClick={onChangeModel}>
              Change model
            </button>
          </>
        ) : chatInfo && chatOff ? (
          <>
            Chat needs an API key.{" "}
            <button type="button" className={LINK_BUTTON} onClick={() => setPanelOpen(true)}>
              Add a key
            </button>
          </>
        ) : (
          "Shows the pieces that match. No model, no cost."
        )}
      </p>
    </div>
  )
}

/** Smooth unless the visitor asked for less motion. */
function motion(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
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
  // A blank question has nothing to search for, so Ask waits for one.
  const blankQuestion = !String(query?.config.text ?? "").trim()
  const askDisabled = p.busy || !indexId || Boolean(blocker) || Boolean(p.needsDocument) || blankQuestion

  // Open on a pipeline whose question has not run yet; folded once it has.
  const answered = p.graph.nodes.some((n) => ASK_STAGES.includes(n.stage) && n.stage !== "query" && p.results[n.id])
  const [open, setOpen] = useState(!answered)

  // When Asking turns back into Ask with an answer, bring the answer into view, so the press never looks like nothing happened.
  const scrollBox = useRef<HTMLDivElement>(null)
  // Change settings under the answer: open the settings, then bring them into view once they are drawn.
  const settingsBox = useRef<HTMLDivElement>(null)
  const [goSettings, setGoSettings] = useState(false)
  const toSettings = () => {
    setOpen(true)
    setGoSettings(true)
  }
  useEffect(() => {
    if (!goSettings) return
    settingsBox.current?.scrollIntoView?.({ behavior: motion(), block: "start" })
    setGoSettings(false)
  }, [goSettings])
  // The key hint, once dismissed, stays dismissed for this tab.
  const [hintDismissed, setHintDismissed] = useState(false)
  const keyed = hasAnyKey(p.server, p.keys)
  const offerChat = keyed === true && useCase?.transform === "search" && Boolean(p.registry.use_case?.chat) && !hintDismissed
  const answerBox = useRef<HTMLDivElement>(null)
  const wasAsking = useRef(Boolean(p.asking))
  useEffect(() => {
    if (wasAsking.current && !p.asking && answered) answerBox.current?.scrollIntoView?.({ behavior: motion(), block: "start" })
    wasAsking.current = Boolean(p.asking)
  }, [p.asking, answered])
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
  const goldAsked = useRef(new Set<string>())
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
            ...(snap.searchIn ? { searchIn: snap.searchIn } : {}),
          }
        : null)
    if (!entry || entry.found !== null) return
    if (!logged) onLog(entry)
    // Pandion says where the gold is; each run is asked once per question set.
    const golds = goldsOf(entry.question, questions)
    const asked = JSON.stringify([entry.runId, golds])
    if (!golds.length || goldAsked.current.has(asked)) return
    goldAsked.current.add(asked)
    findGold(entry.rows, golds).then(
      (found) => found && onLog({ ...entry, found: found.rank }),
      () => goldAsked.current.delete(asked),
    )
  }, [snap, transcript, rows, questions, current, onLog])

  // A result on an Ask step that the settings have moved past: the lists are gone until the next Ask.
  const askStale = !p.busy && [query, retrieve, rerank, useCase].some((n) => n !== undefined && p.results[n.id] !== undefined && p.stale.has(n.id))

  const queryErrors = query ? p.errors[query.id] : undefined
  const setText = (text: string) => {
    if (query) p.onConfig(query.id, { ...query.config, text })
  }

  const buildElapsed = useElapsed(p.buildingStep?.startedAt)

  // An index over several documents names how many; their pages are each document's own.
  const several = documentsOf(p.graph).length
  // Search in one of them: its own chunk set counts its pieces.
  const searched = fileOf(outputs.files, p.searchIn)
  const searchedChunks = useArtifactPayload(searched?.chunksId).data as ChunkSet | undefined
  const searchedPieces = Array.isArray(searchedChunks?.chunks) ? `, ${plural(searchedChunks.chunks.length, "piece", "pieces")}` : ""
  // Search in moved after the results were searched: they no longer answer what the header says, so they go, as after a settings change.
  const scopeMoved = several > 1 && !p.busy && p.askedIn !== undefined && (p.askedIn ?? null) !== (searched?.sha ?? null)
  const movedLine = scopeMoved
    ? `You changed where to search. Ask again to search ${searched ? `${searched.filename} only` : `all ${several} documents`}.`
    : undefined
  const outOfDate = askStale || movedLine !== undefined
  const ready = [
    several > 1 ? plural(several, "document", "documents") : filename,
    // A document without pages (Word, a web page) says nothing of them.
    several < 2 && typeof pages === "number" && pages > 0 ? plural(pages, "page", "pages") : null,
    typeof pieces === "number" ? plural(pieces, "piece", "pieces") : null,
  ].filter(Boolean)

  return (
    <section aria-label="Ask panel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-row shrink-0 items-center justify-between gap-2 border-b border-hairline py-1 pr-2 pl-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-semibold">Ask</h2>
          <span data-testid="index-status" className="text-xs text-fg-muted">
            {p.queued
              ? QUEUED_LINE
              : p.buildingStep
              ? p.buildingStep.title
                ? `Building the index: ${p.buildingStep.title}${buildElapsed !== undefined ? `, ${buildElapsed} s` : ""}`
                : "Building the index"
              : indexId
              ? searched
                ? `Searching ${searched.filename} only${searchedPieces}`
                : `Index ready: ${ready.join(", ")}`
              : sha
                ? "Build the index first."
                : "Pick a document in the Document step, then build the index."}
          </span>
        </div>
        {p.head}
      </div>
      {/* Scrolls on its own: the panel is a docked column or a bottom sheet, never part of the page's scroll. */}
      <div ref={scrollBox} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {outputs.files.length ? <SearchIn files={outputs.files} value={searched?.sha ?? null} onChange={(sha) => p.onSearchIn?.(sha)} /> : null}
        {useCase ? <AnswerMode useCase={useCase} registry={p.registry} hasKey={keyed} onUseCase={p.onUseCase} onChangeModel={toSettings} /> : null}
        {query ? (
          <QuestionField
            value={String(query.config.text ?? "")}
            errors={queryErrors?.fields?.text}
            disabled={askDisabled}
            placeholder={
              searched
                ? `Ask something about ${searched.filename}.`
                : several > 1
                  ? `Ask something about these ${several} documents.`
                  : filename
                    ? `Ask something about ${filename}.`
                    : undefined
            }
            onChange={setText}
            onSubmit={ask}
            action={
              <Button
                size="sm"
                busy={p.asking}
                disabled={askDisabled}
                title={askDisabled ? undefined : ASK_TITLE}
                // A setting changed since the answer: a soft ring says Ask is the next step.
                className={cn(outOfDate && !askDisabled && "ring-[3px] ring-accent-wash")}
                onClick={ask}
              >
                {p.asking ? "Asking" : "Ask"}
              </Button>
            }
          />
        ) : null}
        {p.needsDocument ? <p className="text-xs text-fg-muted">Needs a document.</p> : null}
        {outOfDate ? null : <SearchedFor outputs={outputs} />}
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
            <KeyHint provider={p.keyProvider} />
          </div>
        ) : null}
        {/* The answer comes straight after the question; the sample's questions and the settings follow it. */}
        <div ref={answerBox} data-testid="ask-answer" className="scroll-mt-3">
          <AskResults
            graph={p.graph}
            registry={p.registry}
            outputs={outputs}
            comparisonHidden={p.comparisonHidden}
            stale={askStale}
            moved={movedLine}
            questions={questions}
            onComparison={p.onComparison}
            invite={
              <p data-testid="ask-invite" className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-accent-wash px-2 py-1 text-xs">
                {offerChat ? (
                  <>
                    <span>You have a key. Switch to Chat with a model for a written answer with citations.</span>
                    <button type="button" className={LINK_BUTTON} onClick={() => p.onUseCase("chat")}>
                      Use Chat
                    </button>
                    <button type="button" className={LINK_BUTTON} onClick={() => setHintDismissed(true)}>
                      Dismiss
                    </button>
                  </>
                ) : (
                  <>
                    <span>Try another search or a reranker, and ask again.</span>
                    <button type="button" className={LINK_BUTTON} onClick={toSettings}>
                      Change settings
                    </button>
                  </>
                )}
              </p>
            }
          />
        </div>
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
                  onClick={() => {
                    setText(q.question)
                    // Back up to the question box, where Ask is.
                    scrollBox.current?.scrollTo?.({ top: 0, behavior: motion() })
                  }}
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
          <div ref={settingsBox} data-testid="ask-settings" className="scroll-mt-3">
            <AskSettings
              graph={p.graph}
              registry={p.registry}
              hasKey={keyed}
              errors={p.errors}
              onConfig={p.onConfig}
              onTransform={p.onTransform}
              onReranker={p.onReranker}
              onUseCase={p.onUseCase}
              onRewrite={p.onRewrite}
              onSweep={p.onSweep}
            />
          </div>
        ) : null}
        <Transcript entries={p.transcript} onAskAgain={setText} />
      </div>
    </section>
  )
}
