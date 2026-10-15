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

/** Every step came from an earlier run's cache: nothing was measured this time. */
export const cachedOnly = (c: Cost) => c.steps_run === 0 && c.steps_cached > 0
/** Some steps ran and some came from an earlier run's cache. */
export const partlyCached = (c: Cost) => c.steps_run > 0 && c.steps_cached > 0

export const CACHE_NOTE = "Recipes marked from cache were stored by an earlier run, so their time and cost were not measured this time."

/** The token counts in words, or null when no model counted any. */
export const tokenCounts = (c: Cost) => (counted(c) ? { input: count(c.input_tokens), output: count(c.output_tokens) } : null)

/** What the Cost column shows. */
export type CostCell =
  | { kind: "dollars"; text: string; unpriced: string[]; uncounted: string[] }
  | { kind: "local" }
  | { kind: "unpriced"; models: string[] }
  | { kind: "uncounted"; models: string[] }

export function costCell(c: Cost): CostCell {
  if (c.dollars !== null) return { kind: "dollars", text: dollars(c.dollars), unpriced: c.unpriced_models, uncounted: c.uncounted_models }
  if (c.unpriced_models.length) return { kind: "unpriced", models: c.unpriced_models }
  if (c.uncounted_models.length) return { kind: "uncounted", models: c.uncounted_models }
  return { kind: "local" }
}

/** The no-price tag's title: which models the price table lacks. */
export const unpricedTitle = (models: string[]) => `${models.join(", ")} ${models.length === 1 ? "has" : "have"} no entry in the price table`

/** The overview's sort values: nothing spent is 0, anything unknown (or not measured this time) is null and sorts last. */
export function costValues(c: Cost | null | undefined): { time?: number | null; modelTokens?: number | null; cost?: number | null } {
  if (!c) return {}
  if (cachedOnly(c)) return { time: null, modelTokens: null, cost: null }
  const cell = costCell(c)
  return {
    time: c.seconds,
    modelTokens: counted(c) ? (c.input_tokens ?? 0) + (c.output_tokens ?? 0) : null,
    // Dollars with an unpriced model are only part of the cost.
    cost: cell.kind === "dollars" ? (cell.unpriced.length ? null : c.dollars) : cell.kind === "local" ? 0 : null,
  }
}

/** The three values on one line, for a recipe's head: `2.7 s · 4,120 in / 96 out model tokens · $0.0046`. */
export function costLine(c: Cost): string {
  if (cachedOnly(c)) return "from cache"
  const t = tokenCounts(c)
  const cell = costCell(c)
  const price =
    cell.kind === "dollars"
      ? cell.text + (cell.unpriced.length ? `, no price for ${cell.unpriced.join(", ")}` : "")
      : cell.kind === "unpriced"
        ? `no price for ${cell.models.join(", ")}`
        : cell.kind === "uncounted"
          ? `no token count from ${cell.models.join(", ")}`
          : "local"
  return [seconds(c.seconds), t ? `${t.input} in / ${t.output} out model tokens` : "no model tokens", price].join(" · ")
}

/** Pandion's steps in pipeline order (`STAGE_ORDER`), as the comparison names them. */
const ORDER = ["parse", "clean", "chunk", "embed", "store", "rewrite", "search", "rerank"] as const

/** Pandion's step names as the page's card titles: the embedder and the store are both the Index card. */
const TITLES: Record<string, string> = {
  parse: "Parse",
  clean: "Clean",
  chunk: "Chunk",
  embed: "Index",
  store: "Index",
  rewrite: "Ask",
  search: "Retrieve",
  rerank: "Rerank",
}
export const stageTitle = (stage: string) => TITLES[stage] ?? stage

/** The cards this pipeline runs before `variedFrom`, in pipeline order, by their titles. */
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
  // Comparing the store leaves the embedder before it, which is the same Index card.
  const titles = at < 0 ? [] : ORDER.slice(0, at).filter((s) => has[s]).map(stageTitle)
  return [...new Set(titles)].filter((t) => t !== stageTitle(variedFrom))
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
