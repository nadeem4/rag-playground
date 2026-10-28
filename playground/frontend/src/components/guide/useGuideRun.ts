import { createElement, useEffect, useMemo, useState, type ReactNode } from "react"

import type { NodeState } from "@/api/runState"
import { useSampleQuestions } from "@/api/samples"
import type { Registry, RetrievalResult, SampleCard } from "@/api/types"
import { useArtifactPayload } from "@/api/useArtifact"
import { fresh, finalRows, useAskOutputs } from "@/components/ask/AskResults"
import { findGold, goldsOf } from "@/components/ask/Transcript"
import { rowsFromResult } from "@/components/inspectors/hits"
import type { NodeErrors } from "@/components/pipeline/PipelineColumn"
import { useOutcome } from "@/components/pipeline/useOutcome"
import { Button } from "@/components/ui/button"
import { documentOf } from "@/state/document"
import type { GuideAsk } from "@/state/buildSession"
import { askNodes, infoFor, type PipelineGraph } from "@/state/graph"
import {
  GUIDE_FIX,
  GUIDE_NEUTRAL,
  GUIDE_RULE,
  GUIDE_SAMPLE,
  GUIDE_STEPS,
  guideGraph,
  readGuide,
  readGuideLoaded,
  setGuideLoaded,
  setGuideStep,
  stageNode,
  useGuideHidden,
} from "@/state/guide"
import { askResultLine, fixImproved, fixResultLine, stepResultLine } from "@/state/guideResult"
import { errorHeadline } from "@/state/pipeline"
import { isEdited, isUnsaved, readCurrentId, readPipelines, setCurrentId, STARTER_ID } from "@/state/pipelines"
import type { StarterPipeline } from "@/state/starter"

import type { GuideCoachProps } from "./GuideCoach"
import { GuideAskResults } from "./GuideAskResults"
import { GuideInvite } from "./GuideInvite"
import { GuideReplace } from "./GuideReplace"

const INDEX_STEP = 4
const ASK_STEP = 5
const FIX_STEP = 6

export interface GuideRunInput {
  registry: Registry
  graph: PipelineGraph
  starter: StarterPipeline | null
  samples: SampleCard[] | null
  /** The shown document's results. */
  results: Record<string, NodeState>
  stale: Set<string>
  errors: Record<string, NodeErrors>
  /** The note above the cards when a run could not start. */
  columnError: string | null
  busy: boolean
  edit: (next: PipelineGraph, ...touched: string[]) => void
  /** Build's own run starter: (node id, force, select). */
  start: (target: string | undefined, force: boolean, select?: boolean) => Promise<string | undefined>
  /** Build's own Ask: the same run the Ask panel starts. */
  ask: () => void
  /** Where the Ask step found the answer, kept by Build with the session. */
  guideAsk: GuideAsk | null
  setGuideAsk: (value: GuideAsk | null) => void
  /** Where "Ask again" in the Fix step found the answer; kept apart from guideAsk. */
  guideAfter: GuideAsk | null
  setGuideAfter: (value: GuideAsk | null) => void
  /** Select a card, which opens its settings. */
  selectCard: (id: string) => void
  /** Show a card's output in the Inspector. */
  inspect: (id: string) => void
}

export interface GuideRun {
  active: boolean
  /** The invite, or its replace warning, for the Inspector's empty state. */
  invite: ReactNode
  /** The guide mark of each card: the step it is on, and the cards still to come. */
  marks: Record<string, "current" | "later"> | undefined
  /** The Ask results for the main pane (Ask and Fix steps); null until there are some. */
  askResults: ReactNode
  /** The artifact the shown Ask results came from; a new one means a new Ask. */
  askKey: string | null
  /** The coach's props; null when the guided run is not on. */
  coach: GuideCoachProps | null
}

/** State and wiring of the guided run on Build; the parts it connects are in components/guide. */
export function useGuideRun(a: GuideRunInput): GuideRun {
  const { graph, registry, results, stale } = a
  const hidden = useGuideHidden()
  const [step, setStepState] = useState<number | null>(() => readGuide().step)
  const [confirming, setConfirming] = useState(false)
  const questions = useSampleQuestions(GUIDE_SAMPLE)
  const target = guideGraph(registry, a.samples, questions)

  const index = step ?? 0
  const spec = GUIDE_STEPS[index]
  const node = stageNode(graph, spec.stage)
  const artifact = fresh(results, stale, node)
  const type = node ? infoFor(registry, node)?.output : undefined
  const outcome = useOutcome(node?.stage ?? "source", type, node?.stage === "source" ? undefined : artifact)

  const { guideAsk, setGuideAsk, guideAfter, setGuideAfter } = a
  const goTo = (n: number | null) => {
    setStepState(n)
    setGuideStep(n)
    // Leaving the guided run forgets where the answer landed, so a new run starts clean.
    if (n === null) {
      setGuideAsk(null)
      setGuideAfter(null)
    }
  }
  // The Ask results: the candidates Search returned, the pieces the answer step reads, and where the answer is.
  const outputs = useAskOutputs(graph, results, stale)
  const reranked = Boolean(askNodes(graph).rerank)
  const { rerank: rerankOut, output, retrieve: retrieveOut, retrieveId } = outputs
  const candidates = useMemo(() => (retrieveOut ? rowsFromResult(retrieveOut) : null), [retrieveOut])
  const readRows = useMemo(() => finalRows({ rerank: rerankOut, output, retrieve: retrieveOut }, reranked), [rerankOut, output, retrieveOut, reranked])
  // The read rows come from the Search output when the use case has one; wait for it, not for the retrieval fallback.
  const outputPending = fresh(results, stale, askNodes(graph).useCase) !== undefined && output === undefined
  const golds = useMemo(() => (questions ? goldsOf(String(graph.nodes.find((n) => n.stage === "query")?.config.text ?? ""), questions) : []), [questions, graph])
  const [findFailed, setFindFailed] = useState<string | null>(null)
  const onFix = step === FIX_STEP
  // The Ask step saves its rank as guideAsk. The Fix step saves a later result as guideAfter, and never over the first.
  const saved = onFix ? guideAfter : guideAsk
  const save = onFix ? setGuideAfter : setGuideAsk
  useEffect(() => {
    if ((step !== ASK_STEP && !onFix) || !retrieveId || !candidates || !readRows || outputPending || !golds.length) return
    if (onFix && (guideAsk === null || guideAsk.artifact === retrieveId)) return
    if (saved?.artifact === retrieveId) return
    let live = true
    findGold(candidates, golds).then(
      (f) => live && save({ artifact: retrieveId, found: f ? { rank: f.rank } : null, shown: readRows.length, candidates: candidates.length }),
      () => live && setFindFailed(retrieveId),
    )
    return () => {
      live = false
    }
  }, [step, onFix, retrieveId, candidates, readRows, outputPending, golds, guideAsk, saved, save])
  // The result for the Ask that is on screen now: the Ask step's own, or (in the Fix step) the one after the fix.
  // The Fix step: Chunk size set to the fix value, then Build the index, then Ask again.
  const indexCard = stageNode(graph, "index")
  const sizeSet = stageNode(graph, "chunk")?.config.chunk_size === GUIDE_FIX.chunk_size
  const indexFresh = fresh(results, stale, indexCard) !== undefined
  const asked = saved !== null && saved.artifact === retrieveId && (!onFix || guideAsk?.artifact !== retrieveId) ? saved : null
  // Until the Fix step asks again, its main pane keeps showing the Ask step's candidates.
  const beforeData = useArtifactPayload(onFix && !asked ? guideAsk?.artifact : undefined).data as RetrievalResult | undefined
  const beforeRows = useMemo(() => (beforeData && Array.isArray(beforeData.hits) ? rowsFromResult(beforeData) : null), [beforeData])

  // Step 1 only loads the document; it is never a run.
  const [loaded, setLoadedState] = useState(readGuideLoaded)
  const setLoaded = (v: boolean) => {
    setLoadedState(v)
    setGuideLoaded(v)
  }
  // The Inspector shows the card the step points at.
  const nodeId = node?.id
  useEffect(() => {
    if (step !== null && nodeId) a.inspect(nodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the step and its card only
  }, [step, nodeId])
  const begin = () => {
    if (!target) return
    setConfirming(false)
    setLoaded(false)
    // The guide pipeline is a new working copy, not the saved pipeline that was selected: Save changes must not overwrite that one.
    setCurrentId(null)
    setGuideAsk(null)
    setGuideAfter(null)
    a.edit(target)
    goTo(0)
  }
  const start = () => {
    const doc = documentOf(graph)
    if (!doc) return begin()
    const id = readCurrentId()
    const current = id === STARTER_ID ? a.starter : (readPipelines().find((p) => p.id === id) ?? null)
    const onSample = a.samples?.some((c) => c.sha === doc.sha) ?? false
    const work = current?.id === STARTER_ID ? isEdited(current, graph) || !onSample : isUnsaved(current, graph)
    if (work) setConfirming(true)
    else begin()
  }

  const showInvite = !hidden && step === null && target !== null && Object.keys(results).length === 0
  let invite: ReactNode = null
  if (step === null && confirming) invite = createElement(GuideReplace, { onContinue: begin, onCancel: () => setConfirming(false) })
  else if (showInvite) invite = createElement(GuideInvite, { onStart: start })
  if (step === null) return { active: false, invite, marks: undefined, askResults: null, askKey: null, coach: null }

  // Each card is marked by the first step that points at it.
  const first = new Map<string, number>()
  GUIDE_STEPS.forEach((s, i) => {
    const n = stageNode(graph, s.stage)
    if (n && !first.has(n.id)) first.set(n.id, i)
  })
  const marks: Record<string, "current" | "later"> = {}
  for (const [id, i] of first) if (i > step) marks[id] = "later"
  if (node) marks[node.id] = "current"

  const source = graph.nodes.find((n) => n.stage === "source")
  const filename = String(source?.config.filename ?? "")
  const sha = source?.config.sha
  const card = a.samples?.find((c) => c.sha === sha)
  const pages = card?.pages
  const title = card?.title ?? filename
  const chunk = stageNode(graph, "chunk")
  const dim = outcome?.kind === "ready" ? (outcome.data as { dim?: unknown } | null)?.dim : undefined
  const values: Record<string, string> = {}
  if (pages !== undefined) values.pages = String(pages)
  // The Chunk steps report the size the run uses; the Fix step tells the reader what to set, which is always the fix value.
  if (onFix) values.size = String(GUIDE_FIX.chunk_size)
  else if (chunk?.config.chunk_size !== undefined) values.size = String(chunk.config.chunk_size)
  values.dim = typeof dim === "number" ? String(dim) : "many"

  const onAsk = index === ASK_STEP
  // The Fix step's own run is the Index card's.
  const own = onFix ? (indexCard ? results[indexCard.id] : undefined) : node ? results[node.id] : undefined
  const failed = own?.status === "failed" && !stale.has(own.id)
  const errorNode = onFix ? indexCard : node
  // An Ask can be refused on any of its cards (Search, Rerank, Answer); the coach is the only place the reader sees it.
  const askCards = askNodes(graph)
  const askError = [askCards.query, askCards.retrieve, askCards.rerank, askCards.useCase].map((n) => (n ? a.errors[n.id]?.message : undefined)).find(Boolean)
  let error = failed ? errorHeadline(own.error ?? "") : ((errorNode && a.errors[errorNode.id]?.message) ?? (onAsk || onFix ? askError : undefined) ?? null)
  if (!error && (onAsk || onFix) && !a.busy && a.columnError) error = a.columnError
  if (!error && (onAsk || onFix) && findFailed !== null && findFailed === retrieveId) error = "Could not check where the answer landed. Ask the question again."
  // The step is done only when its own node is, even if a later card ran.
  const isSource = node?.stage === "source"
  const done = onFix
    ? asked !== null && !error
    : isSource
      ? loaded
      : own !== undefined && (own.status === "done" || own.status === "cached") && !stale.has(own.id) && (!onAsk || (asked !== null && !error))
  let line: string | null = null
  if (done && onFix && asked) {
    const chunkLine = outcome?.kind === "ready" && node ? stepResultLine(node.stage, type, outcome.data, { filename, pages }) : null
    line = fixResultLine({ before: guideAsk?.found ?? null, after: asked.found, chunk: chunkLine })
  } else if (done && onAsk && asked) line = askResultLine({ found: asked.found, shown: asked.shown, candidates: asked.candidates })
  else if (done && isSource) line = stepResultLine("source", undefined, null, { filename: title, pages })
  else if (done && node && outcome?.kind === "ready") line = stepResultLine(node.stage, type, outcome.data, { filename, pages })
  else if (done && outcome?.kind === "error") line = "The result could not be read. Run this step again."
  let blockedReason = ""
  let state: GuideCoachProps["state"] = a.busy ? "running" : done ? "done" : "ready"
  if (!node) {
    state = "blocked"
    blockedReason = `This pipeline has no ${spec.stage === "source" ? "Document" : spec.stage[0].toUpperCase() + spec.stage.slice(1)} card, so this step cannot run. Leave the guided run and start it again.`
  } else if (onFix && !a.busy && !indexCard) {
    state = "blocked"
    blockedReason = "This pipeline has no Index card, so this step cannot run. Leave the guided run and start it again."
  } else if (onFix && !a.busy && !sizeSet && !done) {
    state = "blocked"
    blockedReason = `Set Chunk size to ${GUIDE_FIX.chunk_size} before building the index.`
  }
  const question = String(graph.nodes.find((n) => n.stage === "query")?.config.text ?? "")
  // The Fix step's run: build the index, and once it is fresh, ask again.
  const askAgain = onFix && sizeSet && indexFresh
  // The Ask step's Why explains a miss; when the answer ranks among the pieces the answer step reads there is no miss to explain.
  const reached = onAsk && asked !== null && asked.found !== null && asked.found.rank <= asked.shown
  const stepOut = onFix ? { ...spec, run: askAgain ? "Ask again" : spec.run } : reached ? { ...spec, why: "" } : spec

  let extra: ReactNode = null
  if (onFix && node) {
    const improved = done && asked ? fixImproved({ before: guideAsk?.found ?? null, after: asked.found }) : null
    extra = createElement(
      "div",
      { className: "flex flex-col items-start gap-2" },
      createElement(Button, { variant: "outline", onClick: () => a.selectCard(node.id) }, "Open Chunk settings"),
      improved !== null ? createElement("p", { className: "m-0 text-sm text-fg" }, improved ? GUIDE_RULE : GUIDE_NEUTRAL) : null,
    )
  }
  // Ask and Fix show the candidates: the Fix step shows the Ask step's until it asks again.
  const shownAsk = asked ?? (onFix ? guideAsk : null)
  const shownRows = asked ? candidates : onFix ? beforeRows : candidates
  const askResults =
    index >= ASK_STEP && shownAsk && shownRows
      ? createElement(GuideAskResults, { question, candidates: shownRows, shown: shownAsk.shown, found: shownAsk.found })
      : null

  return {
    active: true,
    invite: null,
    marks,
    askResults,
    askKey: askResults ? (shownAsk?.artifact ?? null) : null,
    coach: {
      index,
      question,
      step: stepOut,
      values,
      state,
      result: line,
      error,
      blockedReason,
      extra,
      onRun: () => {
        if (!node) return
        if (isSource) setLoaded(true)
        else if (onAsk || askAgain) a.ask()
        else if (onFix) {
          if (indexCard) void a.start(indexCard.id, false, false)
        }
        else void a.start(node.id, false, index !== INDEX_STEP)
      },
      onNext: () => goTo(index === GUIDE_STEPS.length - 1 ? null : index + 1),
      onLeave: () => goTo(null),
    },
  }
}
