import { useSyncExternalStore } from "react"

import type { GraphNode, Registry, SampleCard, SampleQuestion, Stage } from "@/api/types"

import { sampleGraph, type PipelineGraph } from "./graph"

/**
 * The guided run on Build: seven steps, their copy, the sample and question it
 * follows, and whether this viewer hid the invite or is part way through.
 * Copy may hold {pages}, {size} and {dim}; the coach fills them with measured values.
 */

export type GuideStage = "source" | "parse" | "clean" | "chunk" | "index" | "ask" | "fix"

export interface GuideStep {
  stage: GuideStage
  /** The pipeline card this step points at ("chunk" for the fix). */
  card: Stage
  title: string
  body: string
  run: string
  why: string
}

export const GUIDE_SAMPLE = "chunking-primer"
export const GUIDE_QUESTION_ID = "size-factors"
export const GUIDE_FIX = { chunk_size: 800, chunk_overlap: 80 }

export const GUIDE_INVITE = {
  heading: "New to RAG? Take the guided run.",
  body: "Build a pipeline step by step, find where an answer gets lost, and fix it. It takes about five minutes and needs no API key.",
  start: "Start the guided run",
  hide: "I know RAG, hide this",
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    stage: "source",
    card: "source",
    title: "Pick the document",
    body: "Every run starts with a document. This document has {pages} pages of notes on chunking. We will ask it a single question and follow that question through every step.",
    run: "Use this document",
    why: "The playground keeps the document on your computer, or on the demo for a short time. Nothing is shared.",
  },
  {
    stage: "parse",
    card: "parse",
    title: "Parse turns pages into blocks",
    body: "A PDF is only ink on a page. Parse reads the layout and returns blocks such as headings, paragraphs and lists, in reading order.",
    run: "Run Parse",
    why: "Each heading and each paragraph becomes its own block, so the blocks are far fewer than the words on the pages.",
  },
  {
    stage: "clean",
    card: "clean",
    title: "Clean removes what you never want to find",
    body: "Clean drops repeated text such as page headers, footers and duplicate blocks, so they never crowd out real answers.",
    run: "Run Clean",
    why: "This document has no headers or footers, so little or nothing goes. On a report with a header on every page, Clean matters a lot.",
  },
  {
    stage: "chunk",
    card: "chunk",
    title: "Chunk cuts the text into pieces",
    body: "Search finds pieces, not whole documents. Chunk cuts the text into pieces of at most {size} characters, at natural breaks.",
    run: "Run Chunk",
    why: "No piece can hold more than {size} characters, so a long sentence can be cut between pieces. Each part then holds only some of the answer.",
  },
  {
    stage: "index",
    card: "index",
    title: "Index turns pieces into numbers",
    body: "The embedding model turns each piece into a list of {dim} numbers that stands for its meaning. Pieces that mean similar things get similar numbers.",
    run: "Run Index",
    why: "Now a question can be turned into numbers too, and compared with every piece.",
  },
  {
    stage: "ask",
    card: "retrieve",
    title: "Ask the question",
    body: "Search compares the question with every piece and lists the closest ones. The answer step reads only the best few.",
    run: "Ask the question",
    why: "Each part of a cut sentence matches the question only partly, so whole pieces about chunking in general can score higher. The answer is in the index, but it may never reach the best few.",
  },
  {
    stage: "fix",
    card: "chunk",
    title: "Fix it by making pieces bigger than the sentence",
    body: "The miss started at Chunk, so the fix goes there. Set the chunk size to {size} on the Chunk card, then build the index again.",
    run: "Build the index",
    why: "A piece that holds the whole sentence matches every part of the question, so it rises to the top.",
  },
]

/** Fill {name} placeholders; a name with no value stays as written. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m))
}

/** The starter graph on the primer, asking the size-factors question; null when either is missing. */
export function guideGraph(
  registry: Registry,
  samples: readonly SampleCard[] | null,
  questions: readonly SampleQuestion[] | null,
): PipelineGraph | null {
  const card = samples?.find((s) => s.name === GUIDE_SAMPLE)
  const q = questions?.find((x) => x.id === GUIDE_QUESTION_ID)
  if (!card || !q) return null
  return sampleGraph(registry, { sha: card.sha, filename: card.filename }, q.question)
}

/** The node a step points at: the fix is on Chunk, Ask is on Retrieve. */
export function stageNode(graph: PipelineGraph, stage: GuideStage): GraphNode | undefined {
  const s: Stage = stage === "fix" ? "chunk" : stage === "ask" ? "retrieve" : stage
  return graph.nodes.find((n) => n.stage === s)
}

const HIDDEN_KEY = "rag-playground:guide:v1"
const STEP_KEY = "rag-playground:guide-step:v1"
let hidden: boolean | null = null
let step: number | null | undefined
const listeners = new Set<() => void>()

function readHidden(): boolean {
  if (hidden === null) {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "{}")
      hidden = !!parsed && typeof parsed === "object" && (parsed as { hidden?: unknown }).hidden === true
    } catch {
      hidden = false
    }
  }
  return hidden
}

function readStep(): number | null {
  if (step === undefined) {
    try {
      const raw = window.sessionStorage.getItem(STEP_KEY)
      const n = Number(raw)
      step = raw !== null && Number.isInteger(n) && n >= 0 && n < GUIDE_STEPS.length ? n : null
    } catch {
      step = null
    }
  }
  return step
}

export function readGuide(): { hidden: boolean; step: number | null } {
  return { hidden: readHidden(), step: readStep() }
}

export function setGuideHidden(value: boolean): void {
  hidden = value
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify({ hidden: value }))
  } catch {
    // Blocked storage: remembered for this page only.
  }
  listeners.forEach((l) => l())
}

export function setGuideStep(n: number | null): void {
  step = n
  try {
    if (n === null) window.sessionStorage.removeItem(STEP_KEY)
    else window.sessionStorage.setItem(STEP_KEY, String(n))
  } catch {
    // Blocked storage: remembered for this page only.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGuideHidden(): boolean {
  return useSyncExternalStore(subscribe, readHidden, readHidden)
}

/** For tests: forget the in-memory values so the next read goes to storage. */
export function resetGuideForTests(): void {
  hidden = null
  step = undefined
}
