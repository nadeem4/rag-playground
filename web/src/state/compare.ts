import type { VariantState } from "@/api/runState"
import type { Registry, Stage, Variant } from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { compareLists, ordinal, type ListChange } from "@/components/inspectors/hits"
import type { ChunkStats } from "@/components/inspectors/spans"
import { strategyLabel } from "@/learn/challenges"

import { defaultConfig } from "./graph"
import { errorHeadline } from "./pipeline"
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
  content_layers: "Content layers",
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
/** A list in plain words, as the recipe sentence words it: "body", "body and notes", "body, notes and furniture". */
const listWord = (xs: unknown[]) => {
  const w = xs.map(String)
  return w.length < 2 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`
}
const valueWord = (v: unknown) =>
  typeof v === "boolean" ? (v ? "on" : "off") : v === null ? "native" : typeof v === "string" ? v : Array.isArray(v) ? listWord(v) : JSON.stringify(v)

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

// -------------------------------------------------------------- run status --

/** Where one recipe of a run is, read from its own events alone. */
export type RecipeStatus =
  | { kind: "waiting" }
  | { kind: "running"; shared: boolean; cached: boolean }
  | { kind: "done" }
  | { kind: "failed"; step: string; error: string }
  | { kind: "stopped"; midway?: boolean }

/**
 * One recipe's status from its `VariantState`. A failed node names its step
 * (by `titles`, else its id) and its error headline. The step the run goes
 * through done or cached is done. While it runs, `shared` says an upstream
 * step is running fresh (the first recipe runs them for all), and `cached`
 * that every upstream step so far came from the cache. With no state, it
 * waits, or was stopped once the stream ended without reaching it.
 */
export function recipeStatus(
  state: VariantState | undefined,
  _index: number,
  ids: { targetId: string; throughId: string; upstream: string[]; stopped: boolean; titles?: Record<string, string> },
): RecipeStatus {
  if (!state) return ids.stopped ? { kind: "stopped" } : { kind: "waiting" }
  const failed = Object.values(state.nodes).find((n) => n.status === "failed")
  if (failed) return { kind: "failed", step: ids.titles?.[failed.id] ?? cap(failed.id), error: errorHeadline(failed.error ?? "") }
  const through = state.nodes[ids.throughId]
  if (through && (through.status === "done" || through.status === "cached")) return { kind: "done" }
  if (ids.stopped) return { kind: "stopped", midway: true }
  if (through?.status === "skipped") return { kind: "stopped" }
  const up = ids.upstream.map((id) => state.nodes[id]).filter((n) => n !== undefined)
  const shared = up.some((n) => n.status === "running")
  const cached = up.length > 0 && up.every((n) => n.status === "cached" || n.cache_hit === true)
  return { kind: "running", shared, cached }
}

/** A recipe's status as a sentence; `seconds` is what the browser counted since it started. */
export function statusText(s: RecipeStatus, seconds: number | null): string {
  const secs = `${seconds ?? 0} s`
  switch (s.kind) {
    case "waiting":
      return "Waiting. It starts when the recipe before it finishes."
    case "running":
      if (s.shared) return `Running the shared steps, then this recipe, ${secs}`
      return s.cached ? `Running. The shared steps came from the cache, ${secs}` : `Running this recipe, ${secs}`
    case "failed":
      return `Failed at ${s.step}. ${s.error}`
    case "stopped":
      return s.midway ? "Stopped before it finished." : "Not run. The run was stopped first."
    case "done":
      return "Finished."
  }
}

/** The finding while a run goes: how many have finished, and what to do meanwhile. */
export function runningFinding(total: number, finishedCount: number, overview: boolean): Finding {
  const count = finishedCount === 0 ? "None has finished yet." : `${cap(word(finishedCount))} ${finishedCount === 1 ? "has" : "have"} finished.`
  const f = `Running ${word(total)} ${total === 1 ? "recipe" : "recipes"}. ${count}`
  const sub = `The sentence that compares them appears when every recipe has finished.${overview && finishedCount > 0 ? " You can open a finished one now." : ""}`
  return { finding: f, sub }
}

// ---------------------------------------------------------------- overview --

/** What the overview sorts by: recipe order, a chunk number, or a search number. */
export type SortKey = "order" | "pieces" | "tokens" | "median" | "p95" | "uncovered" | "rank" | "shared" | "returned"

/** Pressing a header that is not sorted: Answer from the best rank, recipe order from the first, every other number from the most. */
export const firstDirection = (key: SortKey): 1 | -1 => (key === "order" || key === "rank" ? 1 : -1)

/**
 * The overview's rows in the order asked for. Recipe order by default. A
 * number sorts the finished rows by it (a missing value after every number),
 * ties in recipe order, and keeps the unfinished rows last in recipe order.
 * Your pipeline sorts like any other row.
 */
export function sortRecipes<R extends { i: number; done: boolean; values: Partial<Record<SortKey, number | null>> }>(rows: R[], key: SortKey, dir: 1 | -1): R[] {
  const byOrder = [...rows].sort((a, b) => a.i - b.i)
  if (key === "order") return dir === 1 ? byOrder : byOrder.reverse()
  const val = (r: R) => r.values[key]
  const ready = byOrder.filter((r) => r.done)
  const rest = byOrder.filter((r) => !r.done)
  ready.sort((a, b) => {
    const x = val(a)
    const y = val(b)
    if (x === y || (x == null && y == null)) return a.i - b.i
    if (x == null) return 1
    if (y == null) return -1
    return (x - y) * dir || a.i - b.i
  })
  return [...ready, ...rest]
}

/** How many of a list's top `k` are in the baseline's top `k`. */
export function sharedTop(base: readonly string[], ids: readonly string[], k = 5): number {
  const top = new Set(base.slice(0, k))
  return ids.slice(0, k).filter((id) => top.has(id)).length
}

/** The overview's finding: the sentence, the line under it, and the link to the recipes it names. */
export interface ManyFinding extends Finding {
  /** The two recipes the link opens side by side, or null. */
  extremes: [number, number] | null
  link: string | null
}

/** One finished chunk recipe for the overview's finding. */
export interface ChunkManyItem {
  i: number
  phrase: string
  stats: ChunkStats
}

/**
 * The chunk overview's finding: the range of piece counts and the recipes at
 * either end, then who leaves nothing out. Null with fewer than two.
 */
export function chunkManyFinding(items: ChunkManyItem[], fit = 3): ManyFinding | null {
  if (items.length < 2) return null
  const most = items.reduce((a, b) => (b.stats.pieces > a.stats.pieces ? b : a))
  const few = items.reduce((a, b) => (b.stats.pieces < a.stats.pieces ? b : a))
  let finding =
    most.stats.pieces === few.stats.pieces
      ? `Every recipe makes ${piecesOf(most.stats.pieces)}.`
      : `From ${few.stats.pieces} to ${most.stats.pieces} pieces. ${cap(most.phrase)} cuts the most, and ${few.phrase} makes the fewest.`
  const whole = items.filter((x) => x.stats.uncovered === 0)
  if (whole.length === 0) finding += " Every recipe leaves something out."
  else if (whole.length === items.length) finding += " None leaves anything out."
  else if (whole.length === 1) finding += ` Only ${whole[0].phrase} leaves nothing out.`
  else finding += ` ${cap(word(whole.length))} of the ${word(items.length)} leave nothing out.`
  const pick = fit > 1 ? ` Pick up to ${word(fit)} recipes to read their pieces side by side.` : " Open any recipe to read its pieces."
  const apart = most.stats.pieces !== few.stats.pieces
  return {
    finding,
    sub: `Smaller pieces match more tightly but carry less context.${pick}`,
    extremes: apart ? [most.i, few.i] : null,
    link: apart && fit > 1 ? "Read the two extremes side by side" : null,
  }
}

/** One finished search recipe for the overview's finding. */
export interface RetrieveManyItem {
  i: number
  phrase: string
  own: boolean
  /** Where the known answer sits, or null when it is not returned or not known. */
  rank: number | null
  /** How many of its top 5 the baseline's top 5 holds; null on the baseline. */
  shared: number | null
  returned: number
  transform: string
  topK: number | null
}

/**
 * The search overview's finding. With a known answer: how many put it first,
 * then up to two notes (does not return it, puts it lower, returns fewer than
 * 5). Without one: how many share all of the baseline's top 5, then the one
 * that shares the fewest and one that returns fewer. The link reads Your
 * pipeline beside the recipe the finding names first.
 */
export function retrieveManyFinding(items: RetrieveManyItem[], goldKnown: boolean, fit = 3, baseName = "Your pipeline"): ManyFinding | null {
  if (items.length < 2) return null
  const base = items.find((x) => x.own) ?? items[0]
  const others = items.filter((x) => x !== base)
  const n = items.length
  // Short means fewer than both the 5 the page reads and the recipe's own top k.
  const isShort = (x: RetrieveManyItem) => x.returned < Math.min(5, x.topK ?? 5)
  let finding: string
  let named: RetrieveManyItem | undefined
  if (goldKnown) {
    const first = items.filter((x) => x.rank === 1).length
    finding = first === n ? `All ${word(n)} put the answer first.` : `${cap(word(first))} of ${word(n)} put the answer first.`
    const notes: { t: string; x: RetrieveManyItem }[] = [
      ...items.filter((x) => x.rank === null).map((x) => ({ t: `${x.phrase} does not return it`, x })),
      ...items.filter((x) => x.rank !== null && x.rank > 1).map((x) => ({ t: `${x.phrase} puts it ${ordinal(x.rank!)}`, x })),
      ...items.filter((x) => x.rank !== null && isShort(x)).map((x) => ({ t: `${x.phrase} returns only ${x.returned}`, x })),
    ]
    if (notes.length) finding += ` ${cap(notes.slice(0, 2).map((x) => x.t).join(", and "))}.`
    named = notes.find((x) => x.x !== base)?.x
  } else {
    const top = Math.min(5, base.returned)
    const all = items.filter((x) => x === base || x.shared === top).length
    finding = `${cap(word(all))} of ${word(n)} share ${top === 1 ? "its one piece" : `all ${top} pieces`} with ${baseName}.`
    const least = Math.min(...others.map((x) => x.shared ?? top))
    const fewest = least < top ? others.find((x) => (x.shared ?? top) === least) : undefined
    const short = others.find((x) => x !== fewest && isShort(x))
    const parts: string[] = []
    if (fewest) parts.push(`${fewest.phrase} shares the fewest, ${least} of ${top}`)
    if (short) parts.push(`${short.phrase} returns only ${short.returned}`)
    if (parts.length) finding += ` ${cap(parts.join(", and "))}.`
    named = fewest ?? short
  }
  const keyword = items.some((x) => x.transform === "bm25" && typeof x.topK === "number" && x.returned < x.topK)
  const pick = fit > 1 ? `Pick up to ${word(fit)} recipes to read their lists side by side.` : "Open any recipe to read its list."
  return {
    finding,
    sub: keyword ? `Keyword search only returns pieces that share a word with the question. ${pick}` : pick,
    extremes: named ? [base.i, named.i] : null,
    link: named && fit > 1 ? `Read ${baseName} beside ${named.phrase}` : null,
  }
}

// --------------------------------------------------------------- open view --

/**
 * What one open column says against Your pipeline: on Chunk, the change in
 * pieces and in characters left out; on Retrieve, how much of the top 5 it
 * shares, where it puts the known answer, and when it returned fewer than 5.
 */
export function columnDelta(
  d:
    | { kind: "chunk"; stats: ChunkStats; base: ChunkStats; baseName?: string }
    | { kind: "retrieve"; shared: number; top: number; rank: number | null; goldKnown: boolean; returned: number; topK?: number | null; baseName?: string },
): string {
  // The baseline: Your pipeline, or the run's first recipe by its phrase when none was the pipeline's own.
  const baseName = d.baseName ?? "Your pipeline"
  if (d.kind === "chunk") {
    const dp = d.stats.pieces - d.base.pieces
    const dl = d.stats.uncovered - d.base.uncovered
    const a = dp === 0 ? `The same number of pieces as ${baseName}` : `${Math.abs(dp)} ${dp > 0 ? "more" : "fewer"} ${Math.abs(dp) === 1 ? "piece" : "pieces"} than ${baseName}`
    const b = dl === 0 ? "" : d.stats.uncovered === 0 ? ", and nothing left out" : `, and ${Math.abs(dl)} ${dl > 0 ? "more" : "fewer"} characters left out`
    return `${a}${b}.`
  }
  let out = `Shares ${d.shared} of ${d.top} ${d.top === 1 ? "piece" : "pieces"} with ${baseName}.`
  if (d.goldKnown) out += d.rank ? ` Puts the answer ${ordinal(d.rank)}.` : " Does not return the answer."
  if (d.returned < Math.min(5, d.topK ?? 5)) out += ` Returns ${d.returned}, not ${Math.min(5, d.topK ?? 5)}.`
  return out
}

/** The finding's line about failed recipes, by their phrases: every one counted, the first named. */
export function failureSentence(phrases: string[], overview: boolean): string | null {
  if (!phrases.length) return null
  const where = overview ? "row" : "column"
  const first = cap(phrases[0])
  if (phrases.length === 1) return `${first} failed, and its ${where} says why.`
  const who = phrases.length === 2 ? `${first} and ${phrases[1]}` : `${first} and ${word(phrases.length - 1)} others`
  return `${who} failed, and their ${where}s say why.`
}
