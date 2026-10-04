import type { Registry, Stage, Variant } from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { compareLists, ordinal, type ListChange } from "@/components/inspectors/hits"
import type { ChunkStats } from "@/components/inspectors/spans"
import { strategyLabel } from "@/learn/challenges"

import { defaultConfig } from "./graph"
import { variantLabels } from "./sweep"

/**
 * Compare's words: what each recipe is called, and the finding sentence that
 * says what differs between them. Pure, so the page and its tests read the
 * same sentences.
 */

/** The most recipes one run takes; the server enforces the same cap. */
export const MAX_RECIPES = 10

/** The fields' titles in sentence case, in place of the schemas' own ("Chunk Size", "Rrf K"). */
export const RECIPE_TITLES: Record<string, string> = {
  chunk_size: "Chunk size",
  chunk_overlap: "Chunk overlap",
  max_tokens: "Most tokens per piece",
  overlap: "Overlap tokens",
  sentences_per_chunk: "Sentences per piece",
  overlap_sentences: "Overlap sentences",
  top_k: "Candidates, top k",
  rrf_k: "RRF k",
  truncate_dim: "Dimensions",
  heading_context: "Heading context",
  keep_tables_whole: "Keep tables whole",
  section_level: "Section level",
  build_fts: "Build the keyword index",
  do_ocr: "Read text in images (OCR)",
  do_table_structure: "Find table structure",
  table_mode: "Table mode",
  heading_hierarchy: "Heading levels",
  join_lines: "Join lines",
  query_expansion: "Query expansion",
  prf_docs: "PRF pieces",
  prf_terms: "PRF terms",
}

/** A recipe's names: in words, its code name, and the short forms a tab or a sentence uses. */
export interface RecipeName {
  /** `Recursive (natural breaks), 400 characters`. */
  name: string
  /** The transform's code name, `recursive_character`. */
  code: string
  /** `400 characters`, or the name when no size tells the recipe apart. */
  short: string
  /** What a finding calls it: `Your pipeline`, `Recursive at 100 characters`, `Dense with top 1`. */
  phrase: string
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

/** How a setting other than the size reads in a name; `joined` parts follow the name with a space, the rest with a comma. */
const NAME_PARTS: Record<string, (v: unknown) => { text: string; joined?: boolean } | null> = {
  top_k: (v) => ({ text: `top ${String(v)}` }),
  rrf_k: (v) => ({ text: `RRF k ${String(v)}` }),
  query_expansion: (v) => (v === "prf" ? { text: "with PRF", joined: true } : null),
}

/** A setting's value in a name: on or off for a switch, the value itself otherwise. */
const valueWord = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : v === null ? "native" : typeof v === "string" ? v : JSON.stringify(v))

/** A strategy's plain name: Build's, or the Ask panel's on Retrieve. */
export function strategyName(stage: Stage, transform: string): string {
  return (stage === "retrieve" ? RETRIEVAL_LABEL[transform] : undefined) ?? strategyLabel(transform)
}

/** The short phrase a chunk recipe goes by in a finding, from its own settings. */
function chunkPhrase(v: Variant): string | null {
  const c = v.config
  switch (v.transform) {
    case "recursive_character":
      return typeof c.chunk_size === "number" ? `Recursive at ${c.chunk_size} characters` : null
    case "sentence_window":
      return typeof c.sentences_per_chunk === "number" ? `By sentence at ${c.sentences_per_chunk}` : null
    case "token_based":
      return typeof c.max_tokens === "number" ? `Fixed ${c.max_tokens}-token pieces` : null
    case "layout_blocks":
      return "By layout block"
    case "markdown_header":
      return "By heading"
    default:
      return null
  }
}

/**
 * Each recipe by Build's plain name (the Ask panel's name on Retrieve), then
 * the size that tells it apart, then each other setting that tells it apart
 * and is away from the strategy's default. A recipe whose name an earlier one
 * already has ends with `, copy 2`, so no two recipes share a name. `own` is
 * the index of the node's own recipe, whose phrase is "Your pipeline".
 */
export function recipeNames(variants: Variant[], stage: Stage, registry: Registry, own?: number): RecipeName[] {
  const labels = variantLabels(variants, registry, stage)
  const plainOf = (v: Variant) => strategyName(stage, v.transform)
  const sizeOf = (i: number) => {
    const field = labels[i].fields.find(([k]) => k in SIZE_UNITS)?.[0]
    return { field, size: field ? sized(field, variants[i].config[field]) : null }
  }
  const heads = variants.map((v, i) => `${plainOf(v)}|${sizeOf(i).size ?? ""}`)
  const seen = new Map<string, number>()
  return variants.map((v, i) => {
    const plain = plainOf(v)
    const { field, size } = sizeOf(i)
    const info = registry[stage]?.[v.transform]
    const defaults = info ? defaultConfig(info) : {}
    // The recipes the plain name and the size do not yet tell apart from this one.
    const peers = variants.filter((_, j) => heads[j] === heads[i])
    const parts = Object.keys(v.config)
      .filter((k) => k !== field && peers.some((p) => JSON.stringify(p.config[k]) !== JSON.stringify(v.config[k])))
      .filter((k) => JSON.stringify(defaults[k]) !== JSON.stringify(v.config[k]))
      .map((k) => (k in NAME_PARTS ? NAME_PARTS[k](v.config[k]) : { text: `${RECIPE_TITLES[k] ?? k} ${valueWord(v.config[k])}` }))
      .filter((p): p is { text: string; joined?: boolean } => p !== null)
    const joined = parts.filter((p) => p.joined).map((p) => p.text)
    const comma = [...(size ? [size] : []), ...parts.filter((p) => !p.joined).map((p) => p.text)]
    let name = [plain, ...joined].join(" ") + (comma.length ? `, ${comma.join(", ")}` : "")
    let short = size ? [size, ...parts.filter((p) => !p.joined).map((p) => p.text)].join(", ") : name
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    if (n > 1) {
      name = `${name}, copy ${n}`
      short = `${short}, copy ${n}`
    }
    const words = [...parts.filter((p) => p.joined).map((p) => p.text.replace(/^with /, "")), ...parts.filter((p) => !p.joined).map((p) => p.text)]
    const phrase =
      i === own
        ? "Your pipeline"
        : ((stage === "chunk" ? chunkPhrase(v) : null) ??
          (stage === "retrieve" ? (words.length ? `${plain} with ${list(words)}` : plain) : name.replace(/, copy \d+$/, "")))
    return { name, code: v.transform, short, phrase }
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

// ------------------------------------------------------------------- plan --

/** How the results open: as columns, one tab at a time, or as an overview to sort. */
export type ResultsMode = "columns" | "tabs" | "overview"

/** Three or fewer that fit: columns. Three or fewer that do not: tabs. Four or more: the overview. */
export function resultsMode(n: number, columnsFit: boolean): ResultsMode {
  return n <= 3 ? (columnsFit ? "columns" : "tabs") : "overview"
}

/** A recipe as the plan sentence needs it: its phrase and its settings. */
export interface PlanItem {
  phrase: string
  transform: string
  config: Record<string, unknown>
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n)
/** "Your pipeline" inside a sentence, after its first word. */
const inSentence = (phrase: string) => (phrase === "Your pipeline" ? "your pipeline" : phrase)

const WAYS: Partial<Record<Stage, string>> = {
  parse: "read the same document",
  chunk: "cut the same document",
  index: "index the same pieces",
  retrieve: "search the same pieces",
}

const WHAT: Partial<Record<Stage, string>> = {
  chunk: "its pieces, numbers and a chunk bar",
  retrieve: "its five best pieces",
}

/**
 * The sentence over the cards before a run: what the run is about to show,
 * and the line under it, how the results will open. With three or more
 * Recursive sizes on Chunk it names that pattern instead of every recipe.
 */
export function planSentence(stage: Stage, items: PlanItem[], mode: ResultsMode, fit: number): { plan: string; sub: string | null } {
  const n = items.length
  if (n === 0) return { plan: "Add a recipe to run.", sub: null }
  if (n === 1) return { plan: `You are about to run ${inSentence(items[0].phrase)} on its own. Add a recipe to compare it with.`, sub: null }
  const sizes = items.filter((x) => x.transform === "recursive_character" && typeof x.config.chunk_size === "number").map((x) => x.config.chunk_size as number)
  let plan: string
  if (stage === "chunk" && sizes.length >= 3) {
    const rest = n - sizes.length
    const others = rest === 0 ? "" : `, and how ${numberWord(rest)} other ${rest === 1 ? "strategy compares" : "strategies compare"}`
    plan = `You are about to see how size changes the pieces, from ${Math.min(...sizes)} to ${Math.max(...sizes)} characters${others}.`
  } else if (n <= 3) {
    const phrases = items.map((x) => inSentence(x.phrase))
    plan = `You are about to compare ${phrases.slice(0, -1).join(", ")} and ${phrases[n - 1]}.`
  } else plan = `You are about to compare ${numberWord(n)} ways to ${WAYS[stage] ?? "run the same step"}.`
  const what = WHAT[stage] ?? "its output"
  const sub =
    mode === "columns"
      ? `After the run, each recipe becomes a column with ${what}, and a sentence up here says what changed.`
      : mode === "tabs"
        ? `After the run, each recipe gets a tab with ${what}, and a sentence up here says what changed.`
        : `After the run, the ${numberWord(n)} recipes open as a table you can sort, and ${fit > 1 ? `you pick up to ${numberWord(fit)} to read side by side` : "you open any one to read it"}.`
  return { plan, sub }
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
