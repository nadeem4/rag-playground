import { createElement, useState, type ReactNode } from "react"

import type { NodeState } from "@/api/runState"
import { useSampleQuestions } from "@/api/samples"
import type { Registry, SampleCard } from "@/api/types"
import { fresh } from "@/components/ask/AskResults"
import type { NodeErrors } from "@/components/pipeline/PipelineColumn"
import { useOutcome } from "@/components/pipeline/useOutcome"
import { documentOf } from "@/state/document"
import { infoFor, type PipelineGraph } from "@/state/graph"
import {
  GUIDE_SAMPLE,
  GUIDE_STEPS,
  guideGraph,
  readGuide,
  setGuideStep,
  stageNode,
  useGuideHidden,
} from "@/state/guide"
import { stepResultLine } from "@/state/guideResult"
import { errorHeadline } from "@/state/pipeline"
import { isEdited, isUnsaved, readCurrentId, readPipelines, STARTER_ID } from "@/state/pipelines"
import type { StarterPipeline } from "@/state/starter"

import type { GuideCoachProps } from "./GuideCoach"
import { GuideInvite } from "./GuideInvite"
import { GuideReplace } from "./GuideReplace"

/** Steps from this one on (Ask and Fix) come with the next slice of the guided run. */
const FIRST_UNBUILT = 5
const INDEX_STEP = 4

export interface GuideRunInput {
  registry: Registry
  graph: PipelineGraph
  starter: StarterPipeline | null
  samples: SampleCard[] | null
  /** The shown document's results. */
  results: Record<string, NodeState>
  stale: Set<string>
  errors: Record<string, NodeErrors>
  busy: boolean
  edit: (next: PipelineGraph, ...touched: string[]) => void
  /** Build's own run starter: (node id, force, select). */
  start: (target: string | undefined, force: boolean, select?: boolean) => Promise<string | undefined>
}

export interface GuideRun {
  active: boolean
  /** The invite, or its replace warning, for the Inspector's empty state. */
  invite: ReactNode
  /** The guide mark of each card: the step it is on, and the cards still to come. */
  marks: Record<string, "current" | "later"> | undefined
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
  const begin = () => {
    if (!target) return
    setConfirming(false)
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
  if (step === null) return { active: false, invite, marks: undefined, coach: null }

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
  const pages = a.samples?.find((c) => c.sha === sha)?.pages
  const chunk = stageNode(graph, "chunk")
  const dim = outcome?.kind === "ready" ? (outcome.data as { dim?: unknown } | null)?.dim : undefined
  const values: Record<string, string> = {}
  if (pages !== undefined) values.pages = String(pages)
  if (chunk?.config.chunk_size !== undefined) values.size = String(chunk.config.chunk_size)
  values.dim = typeof dim === "number" ? String(dim) : "many"

  const own = node ? results[node.id] : undefined
  const failed = own?.status === "failed" && !stale.has(own.id)
  const error = failed ? errorHeadline(own.error ?? "") : ((node && a.errors[node.id]?.message) ?? null)
  // The step is done only when its own node is, even if a later card ran.
  const done = own !== undefined && (own.status === "done" || own.status === "cached") && !stale.has(own.id)
  let line: string | null = null
  if (done && node?.stage === "source") line = stepResultLine("source", undefined, null, { filename, pages })
  else if (done && node && outcome?.kind === "ready") line = stepResultLine(node.stage, type, outcome.data, { filename, pages })
  const state: GuideCoachProps["state"] =
    index >= FIRST_UNBUILT ? "blocked" : a.busy ? "running" : done ? "done" : "ready"
  const question = String(graph.nodes.find((n) => n.stage === "query")?.config.text ?? "")

  return {
    active: true,
    invite: null,
    marks,
    coach: {
      index,
      question,
      step: spec,
      values,
      state,
      result: line,
      error,
      blockedReason: "This step comes in the next part of the guided run.",
      onRun: () => {
        if (node) void a.start(node.id, false, index !== INDEX_STEP)
      },
      onNext: () => goTo(index === GUIDE_STEPS.length - 1 ? null : index + 1),
      onLeave: () => goTo(null),
    },
  }
}
