import { createElement, useEffect, useMemo, useState, type ReactNode } from "react"

import type { NodeState } from "@/api/runState"
import { useSampleQuestions } from "@/api/samples"
import type { Registry, SampleCard } from "@/api/types"
import { fresh, finalRows, useAskOutputs } from "@/components/ask/AskResults"
import { findGold, goldsOf } from "@/components/ask/Transcript"
import { rowsFromResult } from "@/components/inspectors/hits"
import type { NodeErrors } from "@/components/pipeline/PipelineColumn"
import { useOutcome } from "@/components/pipeline/useOutcome"
import { documentOf } from "@/state/document"
import type { GuideAsk } from "@/state/buildSession"
import { askNodes, infoFor, type PipelineGraph } from "@/state/graph"
import {
  GUIDE_SAMPLE,
  GUIDE_STEPS,
  guideGraph,
  readGuide,
  setGuideStep,
  stageNode,
  useGuideHidden,
} from "@/state/guide"
import { askResultLine, stepResultLine } from "@/state/guideResult"
import { errorHeadline } from "@/state/pipeline"
import { isEdited, isUnsaved, readCurrentId, readPipelines, setCurrentId, STARTER_ID } from "@/state/pipelines"
import type { StarterPipeline } from "@/state/starter"

import type { GuideCoachProps } from "./GuideCoach"
import { GuideAskResults } from "./GuideAskResults"
import { GuideInvite } from "./GuideInvite"
import { GuideReplace } from "./GuideReplace"

/** Steps from this one on (the Fix) come with the next task of the guided run. */
const FIRST_UNBUILT = 6
const INDEX_STEP = 4
const ASK_STEP = 5

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
  setGuideAsk: (value: GuideAsk) => void
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

  const goTo = (n: number | null) => {
    setStepState(n)
    setGuideStep(n)
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
  const { guideAsk, setGuideAsk } = a
  useEffect(() => {
    if (step !== ASK_STEP || !retrieveId || !candidates || !readRows || outputPending || !golds.length) return
    if (guideAsk?.artifact === retrieveId) return
    let live = true
    findGold(candidates, golds).then(
      (f) => live && setGuideAsk({ artifact: retrieveId, found: f ? { rank: f.rank } : null, shown: readRows.length, candidates: candidates.length }),
      () => live && setFindFailed(retrieveId),
    )
    return () => {
      live = false
    }
  }, [step, retrieveId, candidates, readRows, outputPending, golds, guideAsk, setGuideAsk])
  const asked = guideAsk !== null && guideAsk.artifact === retrieveId ? guideAsk : null

  // Step 1 only loads the document; it is never a run.
  const [loaded, setLoaded] = useState(false)
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
  if (step === null) return { active: false, invite, marks: undefined, askResults: null, coach: null }

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
  if (chunk?.config.chunk_size !== undefined) values.size = String(chunk.config.chunk_size)
  values.dim = typeof dim === "number" ? String(dim) : "many"

  const own = node ? results[node.id] : undefined
  const failed = own?.status === "failed" && !stale.has(own.id)
  const onAsk = index === ASK_STEP
  let error = failed ? errorHeadline(own.error ?? "") : ((node && a.errors[node.id]?.message) ?? null)
  if (!error && onAsk && !a.busy && a.columnError) error = a.columnError
  if (!error && onAsk && findFailed !== null && findFailed === retrieveId) error = "Could not check where the answer landed. Ask the question again."
  // The step is done only when its own node is, even if a later card ran.
  const isSource = node?.stage === "source"
  const done = isSource
    ? loaded
    : own !== undefined && (own.status === "done" || own.status === "cached") && !stale.has(own.id) && (!onAsk || (asked !== null && !error))
  let line: string | null = null
  if (done && onAsk && asked) line = askResultLine({ found: asked.found, shown: asked.shown, candidates: asked.candidates })
  else if (done && isSource) line = stepResultLine("source", undefined, null, { filename: title, pages })
  else if (done && node && outcome?.kind === "ready") line = stepResultLine(node.stage, type, outcome.data, { filename, pages })
  else if (done && outcome?.kind === "error") line = "The result could not be read. Run this step again."
  let blockedReason = "This step comes in the next part of the guided run. To ask your own question now, leave the guided run."
  let state: GuideCoachProps["state"] = a.busy ? "running" : done ? "done" : "ready"
  if (!node) {
    state = "blocked"
    blockedReason = `This pipeline has no ${spec.stage === "source" ? "Document" : spec.stage[0].toUpperCase() + spec.stage.slice(1)} card, so this step cannot run. Leave the guided run and start it again.`
  }
  if (index >= FIRST_UNBUILT) state = "blocked"
  const question = String(graph.nodes.find((n) => n.stage === "query")?.config.text ?? "")

  return {
    active: true,
    invite: null,
    marks,
    askResults:
      index >= ASK_STEP && asked && candidates
        ? createElement(GuideAskResults, { question, candidates, shown: asked.shown, found: asked.found })
        : null,
    coach: {
      index,
      question,
      step: spec,
      values,
      state,
      result: line,
      error,
      blockedReason,
      onRun: () => {
        if (!node) return
        if (isSource) setLoaded(true)
        else if (onAsk) a.ask()
        else void a.start(node.id, false, index !== INDEX_STEP)
      },
      onNext: () => goTo(index === GUIDE_STEPS.length - 1 ? null : index + 1),
      onLeave: () => goTo(null),
    },
  }
}
