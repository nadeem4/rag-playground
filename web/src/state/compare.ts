import type { Registry, Stage, Variant } from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { compareLists, ordinal, type ListChange } from "@/components/inspectors/hits"
import type { ChunkStats } from "@/components/inspectors/spans"
import { strategyLabel } from "@/learn/challenges"

import { variantLabels } from "./sweep"

/**
 * Compare's words: what each recipe is called, and the finding sentence that
 * says what differs between them. Pure, so the page and its tests read the
 * same sentences.
 */

/** A recipe's names: in words, its code name, and the short form a tab or a sentence uses. */
export interface RecipeName {
  /** `Recursive (natural breaks), 400 characters`. */
  name: string
  /** The transform's code name, `recursive_character`. */
  code: string
  /** `400 characters`, or the plain name when no size tells the recipe apart. */
  short: string
}

/** The fields whose value is a size, with its unit. */
export const SIZE_UNITS: Record<string, string> = {
  chunk_size: "characters",
  max_tokens: "tokens",
  sentences_per_chunk: "sentences",
  truncate_dim: "dimensions",
}

/** A size with its unit; a null width is the embedder's own. */
function sized(field: string, value: unknown): string {
  return value === null ? "native width" : `${String(value)} ${SIZE_UNITS[field]}`
}

/**
 * Each recipe by Build's plain name (the Ask panel's name on Retrieve), plus
 * the first field that tells it apart and has a unit.
 */
export function recipeNames(variants: Variant[], stage: Stage, registry: Registry): RecipeName[] {
  const labels = variantLabels(variants, registry, stage)
  return variants.map((v, i) => {
    const plain = (stage === "retrieve" ? RETRIEVAL_LABEL[v.transform] : undefined) ?? strategyLabel(v.transform)
    const field = labels[i].fields.find(([k]) => k in SIZE_UNITS)?.[0]
    const size = field ? sized(field, v.config[field]) : null
    return { name: size ? `${plain}, ${size}` : plain, code: v.transform, short: size ?? plain }
  })
}

/**
 * Which recipe a rejected run's field errors belong to: the one recipe whose
 * strategy has every named field, narrowed to the recipes changed since the
 * last run when more than one has them. Null when it cannot be told, so the
 * page opens every recipe rather than guess.
 */
export function rejectedRecipe(variants: Variant[], previous: Variant[], fields: string[], stage: Stage, registry: Registry): number | null {
  const has = (v: Variant) => {
    const props = registry[stage]?.[v.transform]?.config_schema.properties ?? {}
    return fields.length > 0 && fields.every((f) => f.split(".")[0] in props)
  }
  let found = variants.map((_, i) => i).filter((i) => has(variants[i]))
  if (found.length > 1) {
    const changed = found.filter((i) => !previous[i] || JSON.stringify(previous[i]) !== JSON.stringify(variants[i]))
    if (changed.length) found = changed
  }
  return found.length === 1 ? found[0] : null
}

// ---------------------------------------------------------------- findings --

/** The sentence that says what differs, and the quieter line under it. */
export interface Finding {
  finding: string
  sub: string | null
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const word = (n: number) => WORDS[n] ?? String(n)
const piecesOf = (n: number) => `${n} ${n === 1 ? "piece" : "pieces"}`
/** `a`, `a and b`, `a, b and c`. */
/** A sentence starts with a capital, whatever the recipe's short name starts with. */
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

/** One chunk recipe's result, for the finding. The first item is the baseline. */
export interface ChunkItem {
  short: string
  transform: string
  /** The recipe's size setting (`chunk_size`, `max_tokens`, `sentences_per_chunk`), or null. */
  size: number | null
  stats: ChunkStats
  /** The node's own recipe on Build: named "Your pipeline" when the pieces are listed. */
  own?: boolean
}

export const CHUNK_SUB =
  "Smaller pieces are tighter matches but carry less context. Ask a question through two of these on Build, or switch to Retrieve to compare searches."

/** How a size change moved the piece count: `doubles the pieces, from 6 to 12`. */
function countChange(from: number, to: number): string {
  if (to === from * 2) return `doubles the pieces, from ${from} to ${to}`
  if (to * 2 === from) return `halves the pieces, from ${from} to ${to}`
  if (to === from) return `leaves the pieces at ${from}`
  return `takes the pieces from ${from} to ${to}`
}

/**
 * The chunk finding. Sentence 1 says how the piece count changed: by the
 * baseline's own strategy at half or double its size when there is one, else
 * recipe by recipe. Sentence 2 names the fewest, when that is not the
 * baseline, and what covers the whole document. When every recipe cut the
 * same pieces and tokens, it says so and stops. Null with fewer than two.
 */
export function chunkFinding(items: ChunkItem[]): Finding | null {
  if (items.length < 2) return null
  const [base] = items
  if (items.every((x) => x.stats.pieces === base.stats.pieces && x.stats.tokens === base.stats.tokens)) {
    const all = items.length === 2 ? "Both recipes" : `All ${items.length} recipes`
    return { finding: `${all} cut the document the same way, into ${piecesOf(base.stats.pieces)}.`, sub: CHUNK_SUB }
  }
  const sized = base.size === null ? undefined : items.slice(1).find((x) => x.transform === base.transform && x.size !== null && (x.size * 2 === base.size || x.size === base.size! * 2))
  let first: string
  if (sized) {
    const verb = sized.size! < base.size! ? "Halving" : "Doubling"
    first = `${verb} the size ${countChange(base.stats.pieces, sized.stats.pieces)}.`
  } else {
    const named = items.map((x, i) => (i === 0 ? `${x.own ? "Your pipeline" : x.short} makes ${piecesOf(x.stats.pieces)}` : `${x.short} makes ${x.stats.pieces}`))
    first = `${named[0]}${named.length > 2 ? ", " : " and "}${list(named.slice(1))}.`
  }
  const least = Math.min(...items.map((x) => x.stats.pieces))
  const fewest = items.filter((x) => x.stats.pieces === least)
  const named = fewest.length === 1 && fewest[0] !== base ? fewest[0] : null
  const whole = items.filter((x) => x.stats.uncovered === 0)
  let second = ""
  if (named && whole.length === 1 && whole[0] === named) {
    second = `${named.short} makes the fewest, ${least}, and is the only recipe that leaves nothing out.`
  } else {
    const parts: string[] = []
    if (named) parts.push(`${named.short} makes the fewest, ${least}.`)
    if (whole.length === items.length) parts.push("Every recipe covers the whole document.")
    else if (whole.length === 1) parts.push(`${whole[0].short} is the only recipe that leaves nothing out.`)
    else if (whole.length > 1) parts.push(`${list(whole.map((x) => x.short))} leave nothing out.`)
    second = parts.join(" ")
  }
  return { finding: second ? `${cap(first)} ${cap(second)}` : cap(first), sub: CHUNK_SUB }
}

/** What one search did against the baseline's list, as a clause. */
function listClause(name: string, c: ListChange, baseName: string): string {
  switch (c.kind) {
    case "same":
      return `${name} returns the same pieces in the same order`
    case "swap":
      return `${name} swaps the ${ordinal(c.places[0])} and ${ordinal(c.places[1])} pieces`
    case "moved":
      return `${name} puts ${c.count} of the same pieces in other places`
    case "shorter":
      return c.returned === 0 ? `${name} returns none` : `${name} returns only ${c.returned}`
    case "different":
      return `${name} shares ${c.shared} of its ${piecesOf(c.of)} with ${baseName}`
  }
}

/**
 * The search finding. `lists` are the recipes' ranked chunk ids, the first
 * being the baseline; `answerRanks` the rank of the piece that holds the
 * sample's gold answer, null when it is not known or not returned. Sentence 1
 * says where the answer sits, and says "the answer" only when a rank is
 * known; otherwise whether every search put the same piece first. Sentence 2
 * says what each other search did to the baseline's list. The sub line says
 * why a keyword search returned fewer, and only when it returned fewer than
 * its own top k: a list cut by a lower top k is not a list of word matches.
 * How many other pieces share no word is said only when the set is counted.
 */
export function retrieveFinding(
  lists: readonly (readonly string[])[],
  names: readonly string[],
  answerRanks: readonly (number | null)[],
  pieces: number | null,
  transforms: readonly string[],
  opts: {
    /** Each recipe's top k, so a short keyword list is read as short only when it returned fewer than it was asked for. */
    topKs?: readonly (number | null)[]
    /** The sample's gold answer is known: with every rank null, no list holds it. */
    goldKnown?: boolean
  } = {},
): Finding | null {
  if (lists.length < 2) return null
  const n = lists.length
  const all = n === 2 ? "Both" : `All ${word(n)}`
  let first: string
  if (answerRanks.every((r) => r === 1)) first = `${all} put the answer first.`
  else if (opts.goldKnown && answerRanks.every((r) => r === null)) first = n === 2 ? "Neither returns the answer." : "None of them returns the answer."
  else if (answerRanks.some((r) => r !== null)) {
    const at = names.map((name, i) => {
      const r = answerRanks[i]
      if (i === 0) return r === null ? `${name} does not return the answer` : `${name} puts the answer ${ordinal(r)}`
      return r === null ? `${name} does not return it` : answerRanks[0] === null ? `${name} puts it ${ordinal(r)}` : `${name} ${ordinal(r)}`
    })
    first = `${list(at)}.`
  } else if (lists.every((l) => l.length > 0 && l[0] === lists[0][0])) first = `${all} put the same piece first.`
  else first = n === 2 ? "They put different pieces first." : "They do not all put the same piece first."
  const changes = lists.map((l) => compareLists(lists[0], l))
  const clauses = changes.slice(1).map((c, k) => listClause(names[k + 1], c, names[0]))
  const second = clauses.length < 2 ? clauses.join("") : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`
  const short = (i: number) => {
    const k = opts.topKs?.[i]
    return typeof k === "number" && lists[i].length < k
  }
  const keyword = changes.findIndex((c, i) => i > 0 && transforms[i] === "bm25" && c.kind === "shorter" && short(i))
  let sub: string | null = null
  if (keyword !== -1) {
    sub = "Keyword search only returns pieces that share a word with the question."
    const rest = pieces === null ? 0 : pieces - lists[keyword].length
    if (rest > 0) sub += rest === 1 ? " The other piece shares none." : ` The other ${rest} pieces share none.`
  }
  return { finding: second ? `${cap(first)} ${cap(second)}.` : cap(first), sub }
}
