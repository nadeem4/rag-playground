import type { Cost } from "@/api/types"

import type { PipelineConfig } from "./config"

/**
 * Time, Tokens and Cost on Compare, read from pandion-api's cost dicts
 * ("Speed and cost" in docs/pandion-api.md). The server does the arithmetic;
 * this only words it. Nothing unknown ever reads as 0 or $0.
 */

/** Two places under a second, one above. */
export const seconds = (s: number) => `${s < 1 ? s.toFixed(2) : s.toFixed(1)} s`

const count = (n: number | null) => (n ?? 0).toLocaleString("en-US")
const dollars = (d: number) => `$${d.toFixed(4)}`
const counted = (c: Cost) => c.input_tokens !== null || c.output_tokens !== null

/** The token counts in words, or null when no model counted any. */
export const tokenCounts = (c: Cost) => (counted(c) ? { input: count(c.input_tokens), output: count(c.output_tokens) } : null)

/** What the Cost column shows. */
export type CostCell =
  | { kind: "dollars"; text: string; unpriced: string[] }
  | { kind: "local" }
  | { kind: "unpriced"; models: string[] }
  | { kind: "uncounted"; models: string[] }

export function costCell(c: Cost): CostCell {
  if (c.dollars !== null) return { kind: "dollars", text: dollars(c.dollars), unpriced: c.unpriced_models }
  if (c.unpriced_models.length) return { kind: "unpriced", models: c.unpriced_models }
  if (c.uncounted_models.length) return { kind: "uncounted", models: c.uncounted_models }
  return { kind: "local" }
}

/** The no-price tag's title: which models the price table lacks. */
export const unpricedTitle = (models: string[]) => `${models.join(", ")} ${models.length === 1 ? "has" : "have"} no entry in the price table`

const CELL_WORDS = { local: "local", unpriced: "no price", uncounted: "no token count" } as const
export const cellWords = (cell: CostCell) => (cell.kind === "dollars" ? cell.text : CELL_WORDS[cell.kind])

/** The overview's sort values: nothing spent is 0, anything unknown is null and sorts last. */
export function costValues(c: Cost | null | undefined): { time?: number; modelTokens?: number | null; cost?: number | null } {
  if (!c) return {}
  const cell = costCell(c)
  return {
    time: c.seconds,
    modelTokens: counted(c) ? (c.input_tokens ?? 0) + (c.output_tokens ?? 0) : null,
    cost: cell.kind === "dollars" ? c.dollars : cell.kind === "local" ? 0 : null,
  }
}

/** The three values on one line, for a recipe's head: `2.7 s · 4,120 in / 96 out · $0.0046`. */
export function costLine(c: Cost): string {
  const t = tokenCounts(c)
  return [seconds(c.seconds), t ? `${t.input} in / ${t.output} out` : "no tokens", cellWords(costCell(c))].join(" · ")
}

/** Pandion's steps in pipeline order (`STAGE_ORDER`), as the comparison names them. */
const ORDER = ["parse", "clean", "chunk", "embed", "store", "rewrite", "search", "rerank"] as const

/** The steps this pipeline runs before `variedFrom`, in pipeline order. */
export function sharedStages(config: PipelineConfig, variedFrom: string): string[] {
  const has: Record<(typeof ORDER)[number], boolean> = {
    parse: true,
    clean: (config.index.clean?.length ?? 0) > 0,
    chunk: true,
    embed: config.index.embed !== undefined,
    store: true,
    rewrite: config.retrieve?.rewrite !== undefined,
    search: config.retrieve !== undefined,
    rerank: (config.retrieve?.rerank?.length ?? 0) > 0,
  }
  const at = ORDER.indexOf(variedFrom as (typeof ORDER)[number])
  return at < 0 ? [] : ORDER.slice(0, at).filter((s) => has[s])
}

/** The line under the recipes about the steps every recipe shares, or null when none is shared. */
export function sharedLine(shared: Cost, stages: string[]): string | null {
  if (shared.steps_run === 0) return shared.steps_cached > 0 ? "The shared steps came from the cache this time." : null
  if (!stages.length) return null
  const t = tokenCounts(shared)
  const spent = t ? `, with ${t.input} in / ${t.output} out tokens${shared.dollars !== null ? ` at ${dollars(shared.dollars)}` : ""}` : ""
  return `Shared steps (${stages.join(", ")}) took ${seconds(shared.seconds)} once${spent}, before the recipes split. They are the same for every recipe, so they are left out of ${t ? "Time, Tokens and Cost" : "Time"}.`
}

export const estimateLine = (c: Cost) => `Cost is an estimate, prices as of ${c.prices_as_of}.`
