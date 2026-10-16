import type { Keys } from "@/api/apiKey"
import type { Registry } from "@/api/types"

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

/** The chat models the registry offers whose provider has a key in this browser, in the registry's order. */
export function chatModels(registry: Registry, keys: Keys): ChatModel[] {
  const schema = registry.use_case?.chat?.config_schema?.properties?.model as Record<string, unknown> | undefined
  const ids = (schema?.enum as string[] | undefined) ?? []
  const providers = (schema?.["x-providers"] as Record<string, string> | undefined) ?? {}
  const labels = (schema?.["x-labels"] as Record<string, string> | undefined) ?? {}
  return ids.flatMap((id) => {
    const provider = providers[id]
    if (!KEYED.includes(provider) || !keys[provider as KeyedProvider]) return []
    return [{ id, label: labels[id] ?? id, provider: provider as KeyedProvider }]
  })
}

/** The cheapest Anthropic model when there is one (Haiku, listed last), else the first model. */
export function defaultModel(models: ChatModel[]): string | null {
  const anthropic = models.filter((m) => m.provider === "anthropic")
  return (anthropic.find((m) => /haiku/i.test(m.id)) ?? anthropic[anthropic.length - 1] ?? models[0])?.id ?? null
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

/** The uploaded file's name says who wrote the set, so the question-set line can say it after a reload too. */
const WRITTEN = /^questions written by (.+)\.json$/

export const writtenFilename = (label: string) => `questions written by ${label}.json`

export function writtenBy(filename: string): string | null {
  return WRITTEN.exec(filename)?.[1] ?? null
}
