import { useCallback, useSyncExternalStore } from "react"

import { hasKeyFor, keySourceLabel, type Keys } from "@/api/apiKey"
import type { LlmSettings, Registry } from "@/api/types"
import { uniqueIds, type Question } from "@/state/goldSet"

/**
 * Questions written for you: the pure half of Evaluate's Write questions for me
 * sheet. A model writes a set for the document as a run
 * (`POST /api/v2/documents/{sha}/questions/generate`); the reader reviews it here
 * and the questions they keep are uploaded like a file would be.
 */

/** How many questions the sheet asks for at first. */
export const DEFAULT_COUNT = 15
/** The most one run may ask for: the hosted demo's cap, and pandion-api's own elsewhere. */
export const DEMO_MAX_COUNT = 25
export const LOCAL_MAX_COUNT = 50
/** With several documents: how many questions per document at first, and at most. */
export const DEFAULT_PER_DOCUMENT = 6
export const MAX_PER_DOCUMENT = 25

/** The providers a key alone is enough for. OpenRouter and a custom endpoint need a model name or an address too. */
type KeyedProvider = "anthropic" | "openai"
const KEYED: readonly string[] = ["anthropic", "openai"]

export interface ChatModel {
  id: string
  label: string
  provider: KeyedProvider
}

/** One question as the run writes it. */
export interface WrittenQuestion {
  id: string
  question: string
  gold_answers: string[]
  answer: string
  tags: string[]
  /** The sha of the document it was written for. Only a set across documents sends it. */
  document?: string
}

export interface WrittenUsage {
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
}

/** The run's result: what `write_questions` returns, less the fields the sheet does not use. */
export interface WrittenSet {
  questions: WrittenQuestion[]
  /** The questions the checks dropped, each with why. */
  dropped: { question: string; reason: string }[]
  usage: WrittenUsage
}

/** One question under review. `original` is the model's wording, so an edit can be put back. */
export interface ReviewItem extends WrittenQuestion {
  original: string
  dropped: boolean
}

/**
 * The chat models the registry offers whose provider has a key, in the
 * registry's order. The app's rule: a key typed here or one the server has, and
 * a key not yet known (the server has not answered) is not ruled out.
 */
export function chatModels(registry: Registry, keys: Keys, server: LlmSettings | null): ChatModel[] {
  const schema = registry.use_case?.chat?.config_schema?.properties?.model as Record<string, unknown> | undefined
  const ids = (schema?.enum as string[] | undefined) ?? []
  const providers = (schema?.["x-providers"] as Record<string, string> | undefined) ?? {}
  const labels = (schema?.["x-labels"] as Record<string, string> | undefined) ?? {}
  return ids.flatMap((id) => {
    const provider = providers[id]
    if (!KEYED.includes(provider) || hasKeyFor(provider as KeyedProvider, server, keys) === false) return []
    return [{ id, label: labels[id] ?? id, provider: provider as KeyedProvider }]
  })
}

/** The cheapest Anthropic model when there is one (Haiku, listed last), else the first model. */
export function defaultModel(models: ChatModel[]): string | null {
  const anthropic = models.filter((m) => m.provider === "anthropic")
  return (anthropic.find((m) => /haiku/i.test(m.id)) ?? anthropic[anthropic.length - 1] ?? models[0])?.id ?? null
}

/** Where the key for this request comes from, as the notice's last sentence. Empty while nobody knows. */
export function keyNotice(provider: KeyedProvider, server: LlmSettings | null, keys: Keys): string {
  if (keys[provider]) return "The key stays in this browser and is sent only with this request."
  if (server === null) return ""
  return `${keySourceLabel(provider, server[provider], null)}.`
}

export function clampCount(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(max, Math.max(1, Math.round(n)))
}

export function reviewItems(set: WrittenSet): ReviewItem[] {
  return set.questions.map((q) => ({ ...q, original: q.question, dropped: false }))
}

export function reviewSummary(items: ReviewItem[]) {
  const kept = items.filter((x) => !x.dropped)
  return {
    keep: kept.length,
    dropped: items.length - kept.length,
    copied: kept.filter((x) => x.tags.includes("copied")).length,
    edited: items.filter((x) => x.question !== x.original).length,
  }
}

const count = (n: number) => n.toLocaleString("en-US")

export function usageLine(label: string, usage: WrittenUsage): string {
  if (usage.input_tokens === null || usage.output_tokens === null) return `${label}, tokens not reported`
  return `${label}, ${count(usage.input_tokens)} in / ${count(usage.output_tokens)} out tokens`
}

/** The kept questions, with their edits, as the JSON set `parse_question_set` reads. */
export function keptSet(items: ReviewItem[], document: string) {
  return {
    version: 1,
    document,
    questions: items
      .filter((x) => !x.dropped)
      .map(({ id, question, gold_answers, answer, tags }) => ({ id, question, gold_answers, answer, tags })),
  }
}

// ------------------------------------------------- for several documents --

/** The line under Questions per document. */
export function perDocumentLine(per: number, documents: number): string {
  if (documents === 0) return "Pick at least one document."
  const n = `${documents} document${documents === 1 ? "" : "s"}`
  return `${per} for each of ${n}: ${per * documents} questions, written one document at a time. They join your set; nothing in it is replaced.`
}

/** One more document's written set after the ones before it: questions and drops in order, tokens summed while every run reported them. */
export function mergeWritten(before: WrittenSet | null, next: WrittenSet): WrittenSet {
  if (!before) return next
  const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b)
  return {
    questions: [...before.questions, ...next.questions],
    dropped: [...before.dropped, ...next.dropped],
    usage: {
      input_tokens: sum(before.usage.input_tokens, next.usage.input_tokens),
      output_tokens: sum(before.usage.output_tokens, next.usage.output_tokens),
      model: before.usage.model ?? next.usage.model,
    },
  }
}

/**
 * The set as it is, every question with its tags, answer and document (a sha,
 * or empty for one naming none), then the kept questions, each naming the
 * document it was written for: the one set `POST /questions` reads, so saving
 * adds and replaces nothing. A written id the set already uses gets a number.
 */
export function joinedSet(existing: readonly Question[], items: readonly ReviewItem[]) {
  const kept: Question[] = items
    .filter((x) => !x.dropped)
    .map(({ id, question, gold_answers, answer, tags, document }) => ({ id, question, gold_answers, answer, tags, document: document ?? "" }))
  const questions = uniqueIds([...existing.map((q) => ({ ...q, document: q.document ?? "" })), ...kept]).map(
    ({ id, question, gold_answers, answer, tags, document }) => ({ id, question, gold_answers, answer, tags, document }),
  )
  return { version: 1, document: "", questions }
}

/** The uploaded file's name says who wrote the set, so the question-set line can say it after a reload too. */
const WRITTEN = /^questions written by (.+)\.json$/

export const writtenFilename = (label: string) => `questions written by ${label}.json`

export function writtenBy(filename: string): string | null {
  return WRITTEN.exec(filename)?.[1] ?? null
}

// ------------------------------------------------------------- the session --

/**
 * One document's run and review (or, keyed by several documents' shas, theirs),
 * held in memory above the page, so leaving
 * Evaluate or switching the pipeline does not lose a run in flight or a review
 * that was paid for. Keyed by the document's fingerprint; a reload drops it.
 */
export interface WriteSession {
  runId: string | null
  /** The model label the run (and so the review) was written by. */
  writer: string
  error: string | null
  written: WrittenSet | null
  items: ReviewItem[]
  /** With several documents: what to write, one document (`shas[at]`) at a time. Null with one. */
  plan: { shas: string[]; count: number; model: string } | null
  at: number
  /** Stop was pressed: no further document is started. */
  stopping: boolean
}

const EMPTY: WriteSession = { runId: null, writer: "", error: null, written: null, items: [], plan: null, at: 0, stopping: false }
let sessions: Record<string, WriteSession> = {}
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

type Patch = Partial<WriteSession> | ((s: WriteSession) => Partial<WriteSession>)

export function useWriteSession(sha: string): [WriteSession, (patch: Patch) => void] {
  const session = useSyncExternalStore(subscribe, () => sessions[sha] ?? EMPTY)
  const update = useCallback(
    (patch: Patch) => {
      const now = sessions[sha] ?? EMPTY
      sessions = { ...sessions, [sha]: { ...now, ...(typeof patch === "function" ? patch(now) : patch) } }
      listeners.forEach((l) => l())
    },
    [sha],
  )
  return [session, update]
}

/** Forget every session, so each test starts clean. */
export function resetWriteSessionsForTests() {
  sessions = {}
}
