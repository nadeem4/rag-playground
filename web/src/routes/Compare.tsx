import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react"

import { useApiKey } from "@/api/apiKey"
import { api } from "@/api/client"
import { useSampleQuestions, useSamples } from "@/api/samples"
import type { NodeState, VariantState } from "@/api/runState"
import type { ChunkSet, GraphNode, Registry, TransformInfo, Variant } from "@/api/types"
import { usePayloads } from "@/api/usePayloads"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { goldRank } from "@/components/ask/Transcript"
import { ChunkEvidence } from "@/components/compare/ChunkEvidence"
import { AddRecipeCard } from "@/components/compare/AddRecipeCard"
import { ExperimentMenu } from "@/components/compare/ExperimentMenu"
import { RecipeCard, type CardTag } from "@/components/compare/RecipeCard"
import { RecipeHead } from "@/components/compare/RecipeHead"
import { OpenView } from "@/components/compare/OpenView"
import { Overview, type OverviewRow } from "@/components/compare/Overview"
import { RecipeStatus } from "@/components/compare/RecipeStatus"
import { RetrieveEvidence } from "@/components/compare/RetrieveEvidence"
import { ValueEditor } from "@/components/compare/ValueEditor"
import { DocumentNote, needsDocument } from "@/components/DocumentNote"
import { EmptyState } from "@/components/EmptyState"
import { CONTROL } from "@/components/fields/types"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { agreementText, compareLists, hitRows, type HitRowData } from "@/components/inspectors/hits"
import { embeddingCounts, type IndexDescriptor } from "@/components/inspectors/IndexInspector"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { chunkSlot, chunkStats } from "@/components/inspectors/spans"
import type { InspectorStatus } from "@/components/inspectors/status"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/SegmentedControl"
import {
  ancestors,
  columnOrder,
  defaultConfig,
  infoFor,
  setConfig,
  setTransform,
  storeGraph,
  terminalNode,
  titleFor,
  transformsFor,
  upstreamOfStage,
  useStoredGraph,
  type PipelineGraph,
} from "@/state/graph"
import { chooseDocument, documentOf, useDocument, type DocRef } from "@/state/document"
import {
  deleteExperiment,
  droppedText,
  readExperiments,
  saveExperiment,
  takeOpenRequest,
  updateExperiment,
  usableExperiment,
  useExperiments,
  type SavedExperiment,
} from "@/state/experiments"
import {
  chunkFinding,
  chunkManyFinding,
  columnDelta,
  failureSentence,
  MAX_RECIPES,
  planSentence,
  RECIPE_TITLES,
  recipeNames,
  recipeStatus,
  rejectedRecipe,
  resultsMode,
  runningFinding,
  retrieveFinding,
  retrieveManyFinding,
  sharedTop,
  sortRecipes,
  strategyName,
  type Finding,
  type ManyFinding,
  type RecipeStatus as Status,
  type ResultsMode,
  type SortKey,
} from "@/state/compare"
import { recipeSentence } from "@/state/recipeSentence"
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { baselineIndex, matryoshkaVariants, tallyLine, tallySweep, variantLabels, variantName, type VariantLabel } from "@/state/sweep"

import { RegistryScreen } from "./Shell"
import { useColumnsFit, useSideBySide } from "./useColumnsFit"
import { useOpenRecipes } from "./useOpenRecipes"
import { useRunClock } from "./useRunClock"

/**
 * Compare: run one node of the Build pipeline over up to ten recipes. Before
 * the run the recipes are equal cards, each a sentence whose values open one
 * floating editor, under a plan sentence. After it, each recipe is a column:
 * its name in words, then the output of the node the run goes through. Where
 * the columns do not fit side by side, one recipe shows at a time, chosen
 * above the grid.
 */

export function Compare() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return <ComparePage registry={reg.registry} />
}

/**
 * Reads the working graph as a store, so a document chosen in the header's
 * bar on this page re-renders the comparison on it, with no reload.
 */
/** The open experiment, as page state: its id and name, and what it holds as saved, to tell an edit. */
export interface OpenExperiment {
  id: string
  name: string
  /** The step, the recipes and the document as saved, in one string. */
  sig: string
  /** Saved just now: the line says Saved until something changes. */
  justSaved: boolean
}

/** The step, the recipes and the document, in one string, to tell whether the page differs from a saved experiment. */
export const experimentSig = (stage: string, recipes: Variant[], doc: DocRef | null) => JSON.stringify({ stage, recipes, doc: doc?.sha ?? null })

function ComparePage({ registry }: { registry: Registry }) {
  // The node under comparison: from the URL on arrival, then from the picker.
  const [wanted, setWanted] = useState<string | null>(() => new URLSearchParams(window.location.search).get("node"))
  const graph = useStoredGraph(registry)
  const [experiment, setExperiment] = useState<OpenExperiment | null>(null)
  // The recipes an experiment opened with, and a count that remounts the comparison on them.
  const [opening, setOpening] = useState<{ n: number; recipes: Variant[] } | null>(null)
  const opens = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)
  const setNode = (id: string) => {
    const q = new URLSearchParams(window.location.search)
    q.set("node", id)
    q.delete("read")
    const url = `${window.location.pathname}?${q.toString()}`
    // From the open view, a new step is a new entry, so Back returns to the step it left.
    if ((window.history.state as { compareRead?: boolean } | null)?.compareRead) window.history.pushState(null, "", url)
    else window.history.replaceState(null, "", url)
    setWanted(id)
  }
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  // Back and Forward can change the step in the URL: follow it.
  useEffect(() => {
    const onPop = () => {
      const node = new URLSearchParams(window.location.search).get("node")
      if (node === wantedRef.current) return
      setExperiment(null)
      setOpening(null)
      setWanted(node)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  /** Open a saved experiment: its step, its recipes on the cards, and its document in the bar. */
  const openExperiment = (e: SavedExperiment) => {
    const node = graph?.nodes.find((n) => n.stage === e.stage)
    if (!graph || !node) {
      setNotice(`This pipeline has no ${e.stage.charAt(0).toUpperCase()}${e.stage.slice(1)} step.`)
      return
    }
    setNotice(null)
    opens.current += 1
    setOpening({ n: opens.current, recipes: structuredClone(e.recipes) })
    setNode(node.id)
    if (e.doc && e.doc.sha !== documentOf(graph)?.sha) void chooseDocument(e.doc)
    setExperiment({ id: e.id, name: e.name, sig: experimentSig(e.stage, e.recipes, e.doc), justSaved: false })
  }
  // Another page (the Library) may have asked for an experiment: open it once, as Your experiments does.
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !graph) return
    asked.current = true
    const id = takeOpenRequest()
    const e = id ? readExperiments().find((x) => x.id === id) : undefined
    if (e && usableExperiment(e, registry)) openExperiment(e)
  })
  const params = new URLSearchParams(window.location.search)
  const target = graph?.nodes.find((n) => n.id === wanted) ?? graph?.nodes.find((n) => n.stage === "chunk")
  if (!graph || !target) {
    return (
      <main className="flex min-h-0 flex-1 flex-col bg-surface">
        <EmptyState title="No pipeline to compare">
          Build a pipeline first, then press Sweep on a card.{" "}
          <a href="/build" className="text-fg underline">
            Go to Build
          </a>
        </EmptyState>
      </main>
    )
  }
  const native = Number(params.get("native")) || undefined
  const preset = params.get("preset") === "matryoshka" && target.stage === "index" ? "matryoshka" : undefined
  // What the step picker offers, in pipeline order: Parse, Chunk and Retrieve, plus the
  // target when it is another stage (Build's Sweep button opens Index here), so it always shows the target.
  const choices = graph.nodes.filter((n) => n.stage === "parse" || n.stage === "chunk" || n.stage === "retrieve" || n === target)
  // Choosing another step closes the experiment.
  const choose = (id: string) => {
    setExperiment(null)
    setOpening(null)
    setNotice(null)
    setNode(id)
  }
  // Keyed on the target and on each experiment opened: a new node means fresh variants, no results and `through` back at the node itself.
  return (
    <Sweep
      key={`${target.id}:${opening?.n ?? 0}`}
      registry={registry}
      graph={graph}
      target={target}
      choices={choices}
      onChoose={choose}
      preset={preset}
      native={native}
      initial={opening?.recipes}
      experiment={experiment}
      onExperiment={setExperiment}
      onOpenExperiment={openExperiment}
      notice={notice}
      onNotice={setNotice}
    />
  )
}

/** Per chunker: its size field, then its overlap field when it has one. */
const SIZE_FIELDS: Record<string, string[]> = {
  recursive_character: ["chunk_size", "chunk_overlap"],
  token_based: ["max_tokens", "overlap"],
  sentence_window: ["sentences_per_chunk", "overlap_sentences"],
  layout_blocks: ["max_tokens"],
  markdown_header: ["max_tokens"],
}

/** The config with its size halved (at least 1) and its overlap halved (at least 0); null when a field is not a number. */
function halved(transform: string, config: Record<string, unknown>): Record<string, unknown> | null {
  const [size, overlap] = SIZE_FIELDS[transform] ?? []
  if (!size || typeof config[size] !== "number") return null
  const next = { ...config, [size]: Math.max(1, Math.floor((config[size] as number) / 2)) }
  if (overlap && typeof config[overlap] === "number") next[overlap] = Math.max(0, Math.floor((config[overlap] as number) / 2))
  return next
}

/**
 * At most three columns, the node's own recipe first. A Chunk node then gets
 * the same recipe at half the size, and By sentence on defaults (Recursive when
 * it already cuts by sentence), so the columns differ on the sample. Any other
 * node, or a chunker without a known size field, gets the next two transforms
 * of its stage in registry order, on defaults.
 */
export function seedVariants(target: GraphNode, transforms: TransformInfo[]): Variant[] {
  const own: Variant = { transform: target.transform, config: target.config }
  if (target.stage === "chunk") {
    const half = halved(target.transform, target.config)
    const third = transforms.find((t) => t.name === (target.transform === "sentence_window" ? "recursive_character" : "sentence_window"))
    if (half && third) return [own, { transform: target.transform, config: half }, { transform: third.name, config: defaultConfig(third) }]
  }
  const others = transforms.filter((t) => t.name !== target.transform).map((t) => ({ transform: t.name, config: defaultConfig(t) }))
  return [own, ...others].slice(0, 3)
}

/**
 * The baseline's plain name in the agreement sentence: the strategy's name on
 * Retrieve (`Hybrid (RRF)`) when no other recipe uses it, `the 1024-dimension
 * index` for a Matryoshka baseline, else its distinguishing values.
 */
function plainName(variants: Variant[], base: number, stage: string, labels: VariantLabel[], dim: number | undefined): string {
  const v = variants[base]
  if ("truncate_dim" in v.config && typeof dim === "number") return `the ${dim}-dimension index`
  const alone = variants.filter((x) => x.transform === v.transform).length === 1
  if (stage === "retrieve" && alone && RETRIEVAL_LABEL[v.transform]) return RETRIEVAL_LABEL[v.transform]
  return variantName(labels[base])
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

const finished = (n?: NodeState) => n !== undefined && (n.status === "done" || n.status === "cached")

/** A recipe on the cards: a stable key, so editing never redraws its card, and what it was seeded or opened as. */
interface Item {
  key: number
  variant: Variant
  /** The recipe as seeded or opened; null for one added on the page. */
  seed: Variant | null
}

/** One line on a strategy for the strategy editor, from the prototype; the registry's summary otherwise. */
const GLOSS: Record<string, string> = {
  recursive_character: "Cuts at paragraphs, then lines, then spaces, to a size in characters.",
  sentence_window: "Groups whole sentences, so no sentence is ever cut.",
  layout_blocks: "Follows the blocks the parser found, and keeps tables whole.",
  token_based: "Cuts every so many tokens, wherever that falls.",
  markdown_header: "Starts a new piece at each heading.",
  hybrid_rrf: "Meaning and keyword search, fused into one list.",
  dense: "Meaning only.",
  bm25: "Keywords only.",
}

/** The prototype's example recipes per stage, in its order, as changes to each strategy's defaults. */
const EXAMPLES: Partial<Record<string, [string, Record<string, unknown>][]>> = {
  chunk: [
    ["recursive_character", { chunk_size: 200, chunk_overlap: 40 }],
    ["sentence_window", {}],
    ["layout_blocks", {}],
    ["recursive_character", { chunk_size: 800, chunk_overlap: 160 }],
    ["recursive_character", { chunk_size: 100, chunk_overlap: 20 }],
    ["sentence_window", { sentences_per_chunk: 2, overlap_sentences: 0 }],
    ["token_based", {}],
    ["markdown_header", {}],
    ["token_based", { max_tokens: 32, overlap: 8 }],
  ],
  retrieve: [
    ["hybrid_rrf", {}],
    ["dense", {}],
    ["bm25", {}],
    ["hybrid_rrf", { rrf_k: 10 }],
    ["hybrid_rrf", { query_expansion: "prf" }],
    ["hybrid_rrf", { rrf_k: 200 }],
    ["dense", { top_k: 3 }],
    ["bm25", { top_k: 1 }],
    ["dense", { top_k: 1 }],
    ["hybrid_rrf", { rrf_k: 20, query_expansion: "prf" }],
  ],
}

/** Why someone would add a suggested recipe, in one line. */
function reasonFor(v: Variant, gloss: string): string {
  const c = v.config
  if (v.transform === "recursive_character" && typeof c.chunk_size === "number") return c.chunk_size > 400 ? "Fewer, longer pieces." : "More, shorter pieces."
  if (v.transform === "dense") return typeof c.top_k === "number" && c.top_k < 5 ? "Meaning only, and a short list." : "Meaning only. No keyword match."
  if (v.transform === "bm25") return "Keywords only. Finds exact words."
  if (v.transform === "hybrid_rrf") return c.query_expansion === "prf" ? "Adds words to the question first." : "Changes how the two lists are fused."
  return gloss
}

/** Up to three recipes not already on the page: the stage's seeds, then the prototype's examples. */
function suggestRecipes(target: GraphNode, transforms: TransformInfo[], have: Variant[]): Variant[] {
  const known = new Set(have.map((v) => JSON.stringify(v)))
  const examples = (EXAMPLES[target.stage] ?? []).flatMap(([t, c]): Variant[] => {
    const info = transforms.find((x) => x.name === t)
    return info ? [{ transform: t, config: { ...defaultConfig(info), ...c } }] : []
  })
  const out: Variant[] = []
  for (const v of [...seedVariants(target, transforms), ...examples, ...transforms.map((t) => ({ transform: t.name, config: defaultConfig(t) }))]) {
    const k = JSON.stringify(v)
    if (known.has(k)) continue
    known.add(k)
    out.push(v)
    if (out.length === 3) break
  }
  return out
}

/** What a tab adds to a recipe's name while the run is not done with it. */
const STATE_SUFFIX: Record<Status["kind"], string> = { done: "", running: ", running", waiting: ", waiting", failed: ", failed", stopped: ", not run" }

/** The run's traceback for a failed recipe, folded. */
function Traceback({ text }: { text: string }) {
  return (
    <details className="rounded-control border border-hairline">
      <summary className="flex h-row-compact items-center px-2 text-xs text-fg-muted select-none hover:bg-muted">Traceback</summary>
      <pre className="m-0 max-h-[240px] overflow-auto border-t border-hairline p-2 font-mono text-2xs text-fg-muted">{text}</pre>
    </details>
  )
}

/** A dashed outline of what a column will show, while its recipe has not finished: the numbers and the bar, or five swatch places. */
export function ResultPlaceholder({ stage }: { stage: string }) {
  const labels = stage === "retrieve" ? ["answer", "shared", "returned"] : ["pieces", "tokens", "median", "left out"]
  return (
    <div aria-hidden className="flex flex-col gap-2 rounded-panel border border-dashed border-hairline p-3">
      <div className="flex gap-4">
        {labels.map((g) => (
          <span key={g} className="flex flex-col gap-1 text-2xs text-fg-muted">
            <span className="h-[14px] w-[28px] rounded-swatch bg-surface-elevated" />
            {g}
          </span>
        ))}
      </div>
      {stage === "retrieve" ? (
        <span className="flex gap-1">
          {[0, 1, 2, 3, 4].map((k) => (
            <span key={k} className="size-[26px] rounded-swatch border border-dashed border-hairline" />
          ))}
        </span>
      ) : (
        <span className="h-[10px] rounded-swatch bg-surface-elevated" />
      )}
    </div>
  )
}

const PLACEHOLDER: Record<ResultsMode, string> = {
  columns: "After the run, this recipe becomes a column.",
  tabs: "After the run, this recipe gets its own tab.",
  overview: "After the run, this recipe is a row in the results table.",
}

function Sweep({
  registry,
  graph,
  target,
  choices,
  onChoose,
  preset,
  native,
  initial,
  experiment,
  onExperiment,
  onOpenExperiment,
  notice,
  onNotice,
}: {
  registry: Registry
  graph: PipelineGraph
  target: GraphNode
  /** The nodes the stage picker offers; always includes `target`. */
  choices: GraphNode[]
  onChoose: (id: string) => void
  /** The recipes an opened experiment starts with, in place of the seeds. */
  initial?: Variant[]
  experiment: OpenExperiment | null
  onExperiment: (e: OpenExperiment | null) => void
  onOpenExperiment: (e: SavedExperiment) => void
  /** A line about experiments: one could not open, or a save dropped the oldest. */
  notice: string | null
  onNotice: (t: string | null) => void
  preset?: "matryoshka"
  native?: number
}) {
  const throughId = useId()
  const transforms = transformsFor(registry, target.stage)
  const order = useMemo(() => columnOrder(graph), [graph])
  // The target and every card that depends on it: where a sweep can stop.
  const downstream = useMemo(() => order.filter((n) => n.id === target.id || ancestors(graph, n.id, registry).has(target.id)), [order, graph, registry, target.id])
  const terminal = terminalNode(graph)
  const [through, setThrough] = useState<string>(() =>
    (preset || target.stage === "index" || target.stage === "retrieve") && terminal && downstream.includes(terminal) ? terminal.id : target.id,
  )
  const nextKey = useRef(0)
  const [items, setItems] = useState<Item[]>(() =>
    (initial ?? (preset ? matryoshkaVariants(target, native) : seedVariants(target, transforms))).map((v) => ({ key: nextKey.current++, variant: v, seed: v })),
  )
  const variants = items.map((x) => x.variant)
  /** The node's own recipe on Build, as it is now. */
  const own = (v: Variant) => same(v, { transform: target.transform, config: target.config })
  // Before the run the recipes are cards; after it, the results.
  const [phase, setPhase] = useState<"setup" | "results">("setup")
  // The one open editor: which card, which value.
  const [editing, setEditing] = useState<{ key: number; field: string } | null>(null)
  // The server's message about one recipe, under that card's sentence.
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({})
  // What the last run ran: its recipes, where it stopped, and on which document.
  // `base` is the recipe that was the node's own when the run started: the columns read against it until the next run.
  const [submitted, setSubmitted] = useState<{ variants: Variant[]; through: string; sha: string; base: number }>({ variants: [], through, sha: "", base: -1 })
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { keys } = useApiKey()
  const run = useRun(runId)
  const busy = submitting || (runId !== null && !run.closed)
  const scroller = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<number, HTMLElement>())
  // A value to focus once the next render has drawn it (after a strategy is picked).
  const focusNext = useRef<{ key: number; field: string } | null>(null)
  const n = variants.length
  const fitAll = useColumnsFit(scroller, Math.max(phase === "results" ? submitted.variants.length : n, 1))
  // The recipe shown when the columns do not fit.
  const [chosen, setChosen] = useState(0)
  // How many recipes fit side by side, at most three, and whether the overview is a list.
  const side = useSideBySide(scroller)
  // The overview's sort and ticks.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "order", dir: 1 })
  const [ticked, setTicked] = useState<number[]>([])
  // Fewer fit after a resize: the ticks are cut to what fits.
  useEffect(() => {
    if (ticked.length > side.fit) setTicked((t) => t.slice(0, side.fit))
  }, [side.fit, ticked.length])

  useEffect(() => {
    const want = focusNext.current
    if (!want) return
    focusNext.current = null
    cards.current.get(want.key)?.querySelector<HTMLElement>(`[data-value="${want.field}"]`)?.focus({ preventScroll: true })
  })

  const shownThrough = graph.nodes.find((n) => n.id === submitted.through) ?? target
  const tally = runId ? tallySweep(run.variants) : null
  const labels = variantLabels(submitted.variants, registry, target.stage)
  const upstream = order.filter((n) => n.stage !== "source" && ancestors(graph, target.id, registry).has(n.id) && n.stage !== "query")
  const filename = String(graph.nodes.find((n) => n.stage === "source")?.config.filename ?? "")
  // The document is the header bar's. Missing or none blocks a run; a new one leaves the results on the old.
  const { status: docStatus } = useDocument()
  const noDocument = needsDocument(docStatus)

  // Per variant: the through node's output, the chunk set to place hits on,
  // and the index descriptor (for its embedding counts).
  const stateOf = (i: number) => run.variants.find((s) => s.index === i)
  const chunkNode = shownThrough.stage === "chunk" ? undefined : upstreamOfStage(graph, shownThrough.id, "chunk")
  const indexNode = target.stage === "index" ? target : upstreamOfStage(graph, shownThrough.id, "index")
  const artifact = (s: VariantState | undefined, id: string | undefined) => (id && finished(s?.nodes[id]) ? s!.nodes[id].artifact_id : undefined)
  const ids = submitted.variants.map((_, i) => ({
    through: artifact(stateOf(i), shownThrough.id),
    chunks: artifact(stateOf(i), chunkNode?.id),
    index: artifact(stateOf(i), indexNode?.id),
  }))
  const payload = usePayloads(ids.flatMap((x) => [x.through, x.chunks, x.index]))
  const hitRowLists = ids.map((x) => hitRows(payload(x.through).data))
  const hitLists = hitRowLists.map((rows) => rows?.map((h) => h.chunk_id) ?? null)
  const base = run.closed ? baselineIndex(submitted.variants, (i) => (hitLists[i]?.length ?? 0) > 0) : null
  // A Matryoshka baseline is named by the width its index was built at, which
  // the descriptor knows even when the variant asked for "native".
  const baseDim = base === null ? undefined : (payload(ids[base]?.index).data as IndexDescriptor | undefined)?.dim
  const baseName = base === null ? "" : plainName(submitted.variants, base, target.stage, labels, baseDim)
  // The question a sweep answers, when the step it runs through reads it.
  const query = graph.nodes.find((n) => n.stage === "query")
  const question = query && ancestors(graph, through, registry).has(query.id) ? String(query.config.text ?? "") : ""

  // The gold answers, when the question is one of the loaded sample's own: only then does the page say "the answer".
  const sha = String(graph.nodes.find((n) => n.stage === "source")?.config.sha ?? "")
  const sample = useSamples().samples?.find((x) => x.sha === sha)
  const asked = useSampleQuestions(sample?.name).find((q) => question && q.question.trim() === question.trim())
  const golds = asked ? [asked.gold_answer, ...(asked.gold_answers ?? [])] : null
  const answerRank = (rows: HitRowData[] | null) => (golds && rows ? goldRank(rows, golds) : null)
  const submittedNames = recipeNames(submitted.variants, target.stage, registry)
  const answerId = (rows: HitRowData[] | null) => {
    const rank = answerRank(rows)
    return rank === null ? null : (rows?.find((r) => r.rank === rank)?.chunk_id ?? null)
  }
  // Each recipe's place in the run, from its own events; seconds counted by this browser.
  const clock = useRunClock(run.variants, busy, runId)
  const titles = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, titleFor(n)])), [graph])
  const upstreamIds = useMemo(() => [...ancestors(graph, target.id, registry)], [graph, target.id, registry])
  const statuses: Status[] = submitted.variants.map((_, i) =>
    recipeStatus(stateOf(i), i, { targetId: target.id, throughId: shownThrough.id, upstream: upstreamIds, stopped: run.closed, titles }),
  )
  const finishedCount = statuses.filter((x) => x.kind === "done" || x.kind === "failed").length
  const searched = (payload(ids[base ?? 0]?.chunks).data as ChunkSet | undefined)?.chunks?.length ?? null

  /** The finding over the recipes that finished, the baseline first; null until there are two. */
  function findingFor(): Finding | null {
    const done = submitted.variants.map((_, i) => i).filter((i) => finished(stateOf(i)?.nodes[shownThrough.id]))
    const sets = done.flatMap((i) => {
      const set = payload(ids[i]?.through).data as ChunkSet | undefined
      return typeof set?.source_text === "string" && Array.isArray(set.chunks) ? [{ i, set }] : []
    })
    if (shownThrough.stage === "chunk" && sets.length === done.length) {
      return chunkFinding(
        sets.map(({ i, set }) => {
          const v = submitted.variants[i]
          const field = SIZE_FIELDS[v.transform]?.[0]
          const size = field && typeof v.config[field] === "number" ? (v.config[field] as number) : null
          return { short: submittedNames[i].short, transform: v.transform, size, stats: chunkStats(set), own: i === submitted.base }
        }),
      )
    }
    if (base === null) return null
    const order = [base, ...done.filter((i) => i !== base && hitLists[i])]
    return retrieveFinding(
      order.map((i) => hitLists[i]!),
      order.map((i) => submittedNames[i].short),
      order.map((i) => answerRank(hitRowLists[i])),
      searched,
      order.map((i) => submitted.variants[i].transform),
      {
        topKs: order.map((i) => (typeof submitted.variants[i].config.top_k === "number" ? (submitted.variants[i].config.top_k as number) : null)),
        goldKnown: golds !== null,
      },
    )
  }

  async function sweep() {
    setError(null)
    setCardErrors({})
    setEditing(null)
    setSubmitting(true)
    try {
      const { run_id } = await api.createSweep(
        {
          graph,
          node_id: target.id,
          variants,
          ...(through !== target.id ? { through } : {}),
        },
        { keys },
      )
      setSubmitted({ variants, through, sha, base: variants.findIndex(own) })
      setRunId(run_id)
      setChosen(0)
      setSort({ key: "order", dir: 1 })
      setTicked([])
      opened.reset()
      setPhase("results")
    } catch (err) {
      // The run never started: back on the cards, the message goes under the recipe it belongs to, with that editor open.
      setPhase("setup")
      const routed = routeRunError(err, graph)
      if (routed.kind === "fields") {
        const fields = Object.keys(routed.errors)
        const at = routed.nodeId === target.id ? rejectedRecipe(variants, submitted.variants, fields, target.stage, registry) : null
        const node = graph.nodes.find((x) => x.id === routed.nodeId)
        const schema = at === null ? undefined : infoFor(registry, { stage: target.stage, transform: variants[at].transform })?.config_schema
        const title = (k: string) => RECIPE_TITLES[k] ?? schema?.properties?.[k]?.title ?? k
        if (at === null) {
          const where = node ? titleFor(node) : routed.nodeId
          setError(Object.entries(routed.errors).map(([k, m]) => (k ? `${where}, ${title(k)}: ${m.join(" ")}` : `${where}: ${m.join(" ")}`)).join(" "))
        } else {
          const key = items[at].key
          const field = fields[0]?.split(".")[0]
          setCardErrors({ [key]: Object.entries(routed.errors).map(([k, m]) => (k ? `${title(k)}: ${m.join(" ")}` : m.join(" "))).join(" ") })
          setEditing({ key, field: field && schema?.properties?.[field] ? field : "transform" })
        }
      } else {
        setError(routed.message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const ownAt = variants.findIndex(own)
  const phrases = recipeNames(variants, target.stage, registry, ownAt === -1 ? undefined : ownAt)
  const mode = resultsMode(n, fitAll)
  const plan = planSentence(
    target.stage,
    variants.map((v, i) => ({ phrase: phrases[i].phrase, transform: v.transform, config: v.config })),
    mode,
    side.fit,
  )
  const strategies = transforms.map((t) => ({ name: t.name, plain: strategyName(target.stage, t.name), gloss: GLOSS[t.name] ?? t.summary ?? "" }))

  const setVariant = (key: number, v: Variant) => {
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, variant: v } : x)))
    setCardErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== key)) : e))
  }
  const add = (v: Variant) => {
    const key = nextKey.current++
    setItems((xs) => [...xs, { key, variant: v, seed: null }])
    // A recipe added opens on its strategy, the first choice to make.
    setEditing({ key, field: "transform" })
  }
  const remove = (key: number) => {
    setItems((xs) => xs.filter((x) => x.key !== key))
    if (editing?.key === key) setEditing(null)
    addRef.current?.querySelector<HTMLElement>("button:last-of-type")?.focus({ preventScroll: true })
  }
  /** Put a finished recipe on Build: the target node takes its strategy and settings. */
  const putOnBuild = (i: number) => {
    const v = submitted.variants[i]
    storeGraph(setConfig(setTransform(graph, target.id, v.transform, registry), target.id, v.config))
  }

  // Experiments: the step, the recipes and the document, saved by name in this browser.
  const experiments = useExperiments()
  const doc = documentOf(graph)
  const sig = experimentSig(target.stage, variants, doc)
  const expEdited = experiment !== null && experiment.sig !== sig
  const body = () => ({ stage: target.stage, recipes: variants, doc })
  const sizeShared = target.stage === "chunk" && variants.some((v, i) => variants.some((w, j) => j !== i && w.transform === v.transform && !same(w.config, v.config)))
  const suggestedName = (
    target.stage === "chunk"
      ? `${sizeShared ? "Chunk sizes" : "Chunkers"} on ${filename || "this document"}`
      : target.stage === "retrieve" && question
        ? `Searches for ${question}`
        : `${titleFor(target)} recipes on ${filename || "this document"}`
  ).slice(0, 80)
  const saveAs = (name: string) => {
    const r = saveExperiment(name, body())
    if (!r) return onNotice("This browser would not save the experiment.")
    onExperiment({ id: r.saved.id, name: r.saved.name, sig, justSaved: true })
    onNotice(r.dropped ? droppedText(r.dropped) : null)
  }
  const saveChanges = () => {
    if (!experiment) return
    if (!updateExperiment(experiment.id, body())) return saveAs(experiment.name)
    onExperiment({ ...experiment, sig, justSaved: true })
    onNotice(null)
  }

  const changeRecipes = () => {
    opened.reset()
    setPhase("setup")
    setRunId(null)
    setSubmitted({ variants: [], through, sha: "", base: -1 })
  }
  /** From a failed column: stop what is left of the run, and open that recipe's card on its strategy. */
  const changeThis = (i: number) => {
    if (busy && runId) void api.cancelRun(runId).catch(() => undefined)
    changeRecipes()
    if (items[i]) setEditing({ key: items[i].key, field: "transform" })
  }

  const visible = fitAll ? submitted.variants.map((_, i) => i) : [Math.min(chosen, Math.max(submitted.variants.length - 1, 0))]
  const shown = visible[0] ?? 0
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${Math.max(visible.length, 1)}, minmax(0, 1fr))` }
  const running = run.variants.length > 0 && !run.closed ? run.variants[run.variants.length - 1].index : null
  const verb = titleFor(target)
  const submittedOwn = submitted.base
  const submittedPhrases = recipeNames(submitted.variants, target.stage, registry, submittedOwn === -1 ? undefined : submittedOwn)
  const overview = phase === "results" && submitted.variants.length >= 4
  const failure = failureSentence(
    statuses.flatMap((x, i) => (x.kind === "failed" ? [submittedPhrases[i].phrase] : [])),
    overview,
  )
  const baseAt = submittedOwn === -1 ? 0 : submittedOwn
  // When no recipe was the pipeline's own, the first is the baseline, named by its phrase everywhere.
  const runBase = submittedOwn === -1 ? (submittedPhrases[0]?.phrase ?? "Your pipeline") : "Your pipeline"
  const baseTop = hitLists[baseAt] ?? []
  const top = Math.min(5, baseTop.length) || 5
  const rows: OverviewRow[] = submitted.variants.map((v, i) => {
    const st = statuses[i]
    const set = payload(ids[i]?.through).data as ChunkSet | undefined
    const stats = target.stage === "chunk" && typeof set?.source_text === "string" && Array.isArray(set.chunks) ? chunkStats(set) : null
    const hits = hitRowLists[i]
    const searchedSet = (payload(ids[i]?.chunks).data as ChunkSet | undefined)?.chunks
    const answer = answerId(hits)
    const ready = st.kind === "done" && (target.stage !== "chunk" || stats !== null) && (target.stage !== "retrieve" || hits !== null)
    return {
      i,
      name: submittedNames[i].name,
      code: v.transform,
      own: i === submittedOwn,
      status: st,
      seconds: clock(i),
      done: ready,
      values:
        target.stage === "chunk"
          ? { pieces: stats?.pieces ?? null, tokens: stats?.tokens ?? null, median: stats?.median ?? null, p95: stats?.p95 ?? null, uncovered: stats?.uncovered ?? null }
          : { rank: answerRank(hits), shared: i === baseAt ? null : sharedTop(baseTop, hitLists[i] ?? []), returned: hits?.length ?? null },
      set,
      pieces: hits?.slice(0, 5).flatMap((h) => {
        const at = h.ordinal ?? searchedSet?.findIndex((c) => c.id === h.chunk_id) ?? -1
        return at >= 0 ? [{ piece: at + 1, slot: chunkSlot(at), answer: h.chunk_id === answer }] : []
      }),
    }
  })
  // The recipes open side by side, kept in the URL; the control that opened them gets focus back.
  const readyIdx = rows.filter((r) => r.done).map((r) => r.i)
  const opened = useOpenRecipes(submitted.variants.length, readyIdx, side.fit)
  const openIds = overview ? opened.ids : null
  const opener = useRef<HTMLElement | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (openIds && !wasOpen.current) backRef.current?.focus({ preventScroll: true })
    if (!openIds && wasOpen.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    wasOpen.current = openIds !== null
  }, [openIds])
  const openRecipes = (list: number[], from: HTMLElement) => {
    opener.current = from
    opened.open(list)
  }
  /** One recipe beside Your pipeline; alone when it is Your pipeline or when one fits. */
  const besideBase = (i: number) => (side.fit === 1 || i === baseAt ? [i] : [baseAt, i])
  const sortedRows = sortRecipes(rows, sort.key, sort.dir)
  // Previous and Next walk the finished recipes in the overview's order, leaving out Your pipeline when it sits beside each one.
  const stepOrder = sortedRows.filter((r) => r.done && !(side.fit > 1 && r.i === baseAt)).map((r) => r.i)
  const others = openIds?.filter((i) => !(side.fit > 1 && i === baseAt)) ?? []
  const current = !openIds ? null : others.length === 1 ? others[0] : openIds.length === 1 ? openIds[0] : null
  const pos = current === null ? -1 : stepOrder.indexOf(current)
  const step = (delta: 1 | -1) => {
    const next = stepOrder[pos + delta]
    if (current === null || next === undefined) return false
    opened.show(besideBase(next))
    return true
  }
  useEffect(() => {
    if (!openIds) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.("input, select, textarea")) return
      if (e.key === "Escape") {
        e.preventDefault()
        opened.close()
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        if (step(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  })
  const nextOne = pos >= 0 ? stepOrder[pos + 1] : undefined
  const pendingNext = sortedRows.find((r) => r.status.kind === "running" || r.status.kind === "waiting")
  const nextLine =
    current === null
      ? null
      : nextOne !== undefined
        ? `Next: ${submittedNames[nextOne].name}. Press Next or the right arrow key.`
        : pendingNext
          ? `${submittedNames[pendingNext.i].name} is ${pendingNext.status.kind}. Its chip fills in when it finishes; this view stays put.`
          : "This is the last recipe in the table's order."
  /** The sentence an open column says against Your pipeline. */
  const topKOf = (i: number) => (typeof submitted.variants[i]?.config.top_k === "number" ? (submitted.variants[i].config.top_k as number) : null)
  const deltaFor = (i: number): string | null => {
    if (i === baseAt) return target.stage === "retrieve" ? "The baseline. The other recipes are read against this list." : null
    const r = rows[i]
    const b = rows[baseAt]
    if (!r?.done || !b?.done) return null
    if (target.stage === "chunk") return columnDelta({ kind: "chunk", stats: chunkStats(r.set as ChunkSet), base: chunkStats(b.set as ChunkSet), baseName: runBase })
    if (target.stage === "retrieve")
      return columnDelta({ kind: "retrieve", shared: r.values.shared ?? 0, top, rank: r.values.rank ?? null, goldKnown: golds !== null, returned: r.values.returned ?? 0, topK: topKOf(i), baseName: runBase })
    return null
  }
  const manyFinding = (): (Finding & Partial<ManyFinding>) | null => {
    const doneRows = rows.filter((r) => r.done)
    if (target.stage === "chunk") {
      return chunkManyFinding(
        doneRows.map((r) => ({ i: r.i, phrase: submittedPhrases[r.i].phrase, stats: chunkStats(r.set as ChunkSet) })),
        side.fit,
      )
    }
    if (target.stage === "retrieve") {
      return retrieveManyFinding(
        doneRows.map((r) => ({
          i: r.i,
          phrase: submittedPhrases[r.i].phrase,
          own: r.own,
          rank: r.values.rank ?? null,
          shared: r.values.shared ?? null,
          returned: r.values.returned ?? 0,
          transform: submitted.variants[r.i].transform,
          topK: typeof submitted.variants[r.i].config.top_k === "number" ? (submitted.variants[r.i].config.top_k as number) : null,
        })),
        golds !== null,
        side.fit,
        runBase,
      )
    }
    return findingFor()
  }
  const done: (Finding & Partial<ManyFinding>) | null = run.closed ? (overview ? manyFinding() : findingFor()) : null
  const link = overview && done?.link && done.extremes ? { label: done.link, ids: done.extremes } : null
  const finding: Finding | null = !runId
    ? null
    : !run.closed
      ? runningFinding(submitted.variants.length, finishedCount, overview)
      : done || failure
        ? { finding: [done?.finding, failure].filter(Boolean).join(" "), sub: done?.sub ?? null }
        : null
  const ran = submitted.variants.length
  // On Retrieve every recipe searches the one chunk set, so a colour is the same piece in every column.
  const note =
    finding && !overview && target.stage === "retrieve" && searched !== null
      ? `The colours are piece numbers, the same in every column, because ${ran === 1 ? "the one recipe searches" : ran === 2 ? "both recipes search" : `all ${NUMBER_WORDS[ran] ?? ran} recipes search`} the same ${searched} ${searched === 1 ? "piece" : "pieces"}.`
      : null
  const suggestions = suggestRecipes(target, transforms, variants).map((v) => ({
    name: recipeNames([...variants, v], target.stage, registry)[n].name,
    reason: reasonFor(v, GLOSS[v.transform] ?? transforms.find((t) => t.name === v.transform)?.summary ?? ""),
    variant: v,
  }))
  const firstDefaults = () => add({ transform: transforms[0].name, config: defaultConfig(transforms[0]) })

  /**
   * One result column: its head, then its status while unfinished, its
   * traceback when failed, else what it produced. `delta`, in the open view,
   * is the sentence that reads it against Your pipeline.
   */
  function renderColumn(i: number, delta: string | null) {
    const s = stateOf(i)
    const out = payload(ids[i]?.through)
    const chunks = payload(ids[i]?.chunks)
    const descriptor = payload(ids[i]?.index).data as IndexDescriptor | undefined
    const agreement =
      base !== null && i !== base && hitLists[i] && hitLists[base] ? agreementText(compareLists(hitLists[base]!, hitLists[i]!), baseName) : null
    return (
      <section key={i} aria-label={submittedNames[i].name} className="flex min-w-0 flex-col gap-3 bg-surface p-3">
        <RecipeHead
          name={submittedNames[i].name}
          code={submittedNames[i].code}
          own={i === submitted.base}
          onUse={statuses[i].kind === "done" && i !== submitted.base ? () => putOnBuild(i) : undefined}
          used={i !== submitted.base && own(submitted.variants[i])}
        />
      {delta && target.stage !== "retrieve" && statuses[i].kind === "done" ? <p className="m-0 text-sm font-medium text-fg">{delta}</p> : null}
        {statuses[i].kind !== "done" ? (
          <>
            <RecipeStatus status={statuses[i]} seconds={clock(i)} onChange={() => changeThis(i)} />
            {statuses[i].kind === "failed" ? (
              <Traceback text={Object.values(s?.nodes ?? {}).find((x) => x.status === "failed")?.error ?? ""} />
            ) : statuses[i].kind !== "stopped" ? (
              <ResultPlaceholder stage={target.stage} />
            ) : null}
          </>
        ) : (
        <VariantResult
          state={s}
          pending
          node={shownThrough}
          type={
            shownThrough.id === target.id
              ? (infoFor(registry, { stage: target.stage, transform: submitted.variants[i]?.transform ?? target.transform })?.output ?? "unknown")
              : (infoFor(registry, shownThrough)?.output ?? "unknown")
          }
          data={out.data}
          status={ids[i]?.chunks && chunks.status.kind === "loading" ? { kind: "loading" } : out.status}
          chunks={chunks.data}
          agreement={
            delta !== null && target.stage === "retrieve"
        ? delta
        : (agreement ?? (i === base && hitLists.some((h, j) => j !== i && h) ? "The baseline. The other recipes are read against this list." : null))
          }
          embeddings={target.stage === "index" ? embeddingCounts(descriptor) : null}
          hits={hitRowLists[i]}
          answer={answerId(hitRowLists[i])}
        />
        )}
      </section>
    )
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-1 px-3 pt-3 pb-2">
          <h1 className="text-xl font-semibold">Compare</h1>
          {/* Wraps rather than truncates, as on Evaluate: the filename stays whole at phone width. */}
          <p className="text-sm text-fg-muted">
            The {verb} step over {filename ? <span className="font-mono">{filename}</span> : "no document yet"}
            {upstream.length ? (
              <>
                , after <span className="font-mono">{upstream.map((n) => n.transform).join(", ")}</span>
              </>
            ) : null}
            {preset ? ", at Matryoshka dimensions" : null}
            {question ? (
              <>
                , for{" "}
                <q data-testid="sweep-question" className="font-serif text-fg" style={{ quotes: '"“" "”"' }}>
                  {question}
                </q>
                .{" "}
                {/* Inline in the sentence, so the touch rule's min height needs an inline-flex box to apply. */}
                <a href="/build" className="text-fg underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center">
                  Change the question on Build
                </a>
              </>
            ) : null}
          </p>
          {experiment ? (
            <p data-testid="experiment-line" className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="text-fg-muted">Experiment</span> <b className="font-semibold">{experiment.name}</b>
              {expEdited ? (
                <span className="rounded-swatch bg-stale-wash px-2 py-px text-xs text-stale">Edited since saved</span>
              ) : experiment.justSaved ? (
                <span role="status" className="text-xs text-fg-muted">
                  Saved
                </span>
              ) : null}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="m-0 text-sm text-fg-muted">
              {notice}
            </p>
          ) : null}
        </div>

        {/* The tools stay in reach while ten cards scroll under them. */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-3 py-2">
          <SegmentedControl
            label="Step to compare"
            options={choices.map((n) => ({ value: n.id, label: titleFor(n), disabled: busy }))}
            value={target.id}
            onChange={onChoose}
          />
          {/* Parse and Chunk columns show their own output; only a later stage has a choice of where to stop. */}
          {downstream.length > 1 && target.stage !== "parse" && target.stage !== "chunk" ? (
            <div className="flex items-center gap-2">
              <label htmlFor={throughId} className="text-sm whitespace-nowrap text-fg-muted">
                Show through
              </label>
              <select id={throughId} className={`${CONTROL} w-auto min-w-[10rem]`} value={through} disabled={busy || phase === "results"} onChange={(e) => setThrough(e.target.value)}>
                {downstream.map((n) => (
                  <option key={n.id} value={n.id}>
                    {titleFor(n)}
                    {n.stage === "clean" || n.stage === "rerank" ? ` ${n.id}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {/* Below md the run buttons take their own full-width row, so Run is never pushed off a phone screen. */}
          <div className="flex basis-full flex-wrap items-center gap-2 md:ml-auto md:basis-auto">
            {busy ? null : (
              // Below md the experiment buttons take a row of their own, so the run buttons are never squeezed.
              <div data-testid="experiment-tools" className="flex basis-full md:basis-auto">
              <ExperimentMenu
                experiments={experiments}
                usable={(e) => usableExperiment(e, registry) !== null}
                current={experiment}
                edited={expEdited}
                suggestedName={suggestedName}
                recipeCount={n}
                onOpen={onOpenExperiment}
                onDelete={(e) => {
                  deleteExperiment(e.id)
                  if (experiment?.id === e.id) onExperiment(null)
                }}
                onSave={saveAs}
                onSaveAsNew={saveAs}
                onSaveChanges={saveChanges}
              />
              </div>
            )}
            {phase === "results" && busy && runId ? (
              <Button variant="ghost" size="sm" className="min-w-fit flex-1 md:flex-none" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
                Stop the run
              </Button>
            ) : phase === "results" ? (
              <Button variant="outline" size="sm" className="min-w-fit flex-1 md:flex-none" onClick={changeRecipes}>
                Change recipes
              </Button>
            ) : null}
            {noDocument ? <span className="self-center text-xs text-fg-muted">Needs a document.</span> : null}
            <Button size="sm" className="min-w-fit flex-1 md:flex-none" aria-busy={busy || undefined} disabled={busy || n === 0 || noDocument} onClick={() => void sweep()}>
              {busy ? "Running" : `Run ${n} ${n === 1 ? "recipe" : "recipes"}`}
            </Button>
          </div>
        </div>

        <DocumentNote action="run these recipes" changed={runId !== null && submitted.sha !== "" && submitted.sha !== sha} className="mx-3 mt-3" />

        {phase === "setup" ? (
          <>
            <div className="flex flex-col gap-1 px-3 py-3" aria-live="polite">
              {error ? (
                <p role="alert" className="text-sm break-words text-danger">
                  {error}
                </p>
              ) : null}
              <p data-testid="plan" className="m-0 max-w-[52ch] font-sans text-lg text-balance">
                {plan.plan}
              </p>
              {plan.sub ? <p className="m-0 max-w-[70ch] text-sm text-fg-muted">{plan.sub}</p> : null}
            </div>
            <div data-testid="recipe-cards" className="grid auto-rows-auto grid-cols-1 gap-4 px-3 pb-6 md:auto-rows-fr md:grid-cols-2 lg:grid-cols-3">
              {items.map((item, i) => {
                const v = item.variant
                const info = infoFor(registry, { stage: target.stage, transform: v.transform })
                const schema = info?.config_schema ?? { type: "object", properties: {} }
                const mine = own(v)
                const tag: CardTag = mine ? "Your pipeline" : item.seed === null ? "New" : !same(item.seed, v) ? "Edited" : `Recipe ${i + 1}`
                const open = editing?.key === item.key ? editing.field : null
                return (
                  <RecipeCard
                    key={item.key}
                    cardRef={(el) => {
                      if (el) cards.current.set(item.key, el)
                      else cards.current.delete(item.key)
                    }}
                    index={i}
                    own={mine}
                    tag={tag}
                    parts={recipeSentence(v, schema, strategyName(target.stage, v.transform))}
                    code={v.transform}
                    stage={target.stage}
                    placeholder={PLACEHOLDER[mode]}
                    openField={open}
                    onOpen={(field) => setEditing(open === field ? null : { key: item.key, field })}
                    onRemove={mine || n < 2 || busy ? undefined : () => remove(item.key)}
                    error={cardErrors[item.key] ?? null}
                    editor={
                      open ? (
                        <ValueEditor
                          key={open}
                          field={open}
                          schema={schema}
                          config={v.config}
                          onChange={(config) => setVariant(item.key, { ...v, config })}
                          transform={v.transform}
                          strategies={strategies}
                          onPick={(name) => {
                            const next = transforms.find((t) => t.name === name)
                            if (next && name !== v.transform) setVariant(item.key, { transform: name, config: defaultConfig(next) })
                            setEditing(null)
                            focusNext.current = { key: item.key, field: "transform" }
                          }}
                          onClose={() => setEditing(null)}
                        />
                      ) : null
                    }
                  />
                )
              })}
              <div ref={addRef} className="contents">
                <AddRecipeCard count={n} max={MAX_RECIPES} suggestions={suggestions} onAdd={add} onDefaults={firstDefaults} />
              </div>
            </div>
          </>
        ) : (
          <>
            {/* The finding says what differs before any column does; the tally under it is the quiet fact of what ran. */}
            <div className="flex flex-col gap-1 border-b border-hairline px-3 py-3" aria-live="polite">
              {tally ? (
                <>
                  {finding ? (
                    <>
                      <p data-testid="compare-finding" className="m-0 max-w-[52ch] font-sans text-lg text-balance">
                        {finding.finding}
                      </p>
                      {finding.sub ? (
                        <p data-testid="compare-sub" className="m-0 max-w-[70ch] text-sm text-fg-muted">
                          {finding.sub}
                        </p>
                      ) : null}
                      {/* Kept mounted while the view is open, so closing it can give the link its focus back. */}
                      {link ? (
                        <p className="m-0" hidden={openIds !== null}>
                          <button
                            type="button"
                            onClick={(e) => openRecipes(link.ids.slice(0, side.fit), e.currentTarget)}
                            className={`${LINK_BUTTON} text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center`}
                          >
                            {link.label}
                          </button>
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {!run.closed ? (
                    <div
                      role="progressbar"
                      aria-label="Recipes finished"
                      aria-valuemin={0}
                      aria-valuenow={finishedCount}
                      aria-valuemax={submitted.variants.length}
                      className="mt-1 h-[4px] max-w-[52ch] overflow-hidden rounded-full bg-surface-elevated"
                    >
                      {/* The fill grows by scaleX only. */}
                      <div
                        className="h-full origin-left rounded-full bg-primary transition-transform duration-(--dur-mid) ease-(--ease-in) motion-reduce:transition-none"
                        style={{ transform: `scaleX(${submitted.variants.length ? finishedCount / submitted.variants.length : 0})` }}
                      />
                    </div>
                  ) : null}
                  <p data-testid="tally" className="m-0 text-xs text-fg-muted">
                    <MonoNumbers text={tallyLine(tally, order.map((n) => ({ id: n.id, title: titleFor(n) })))} />
                    {running !== null ? ` Running recipe ${running + 1} of ${submitted.variants.length}.` : run.closed ? "" : " Starting."}
                  </p>
                  {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
                </>
              ) : null}
            </div>

            {openIds ? (
              <OpenView
                total={submitted.variants.length}
                shown={openIds}
                chips={sortedRows.map((r) => ({ i: r.i, label: r.own ? "Your pipeline" : submittedNames[r.i].short, kind: r.done ? "done" : r.status.kind === "done" ? "running" : r.status.kind }))}
                onChip={(i) => opened.show(besideBase(i))}
                onBack={() => opened.close()}
                backRef={backRef}
                nextLine={nextLine}
                position={
                  current === null || pos < 0
                    ? null
                    : { at: pos + 1, of: stepOrder.length, beside: side.fit > 1, prev: pos > 0, next: nextOne !== undefined }
                }
                onStep={(d) => void step(d)}
                baseName={runBase}
                note={
                  target.stage === "retrieve" && searched !== null
                    ? `The colours are piece numbers, the same in every column, because every recipe searches the same ${searched} ${searched === 1 ? "piece" : "pieces"}.${golds !== null ? " The ringed piece holds the answer." : ""}`
                    : null
                }
              >
                <div data-testid="open-grid" className="grid gap-px bg-hairline" style={{ gridTemplateColumns: `repeat(${openIds.length}, minmax(0, 1fr))` }}>
                  {openIds.map((i) => renderColumn(i, deltaFor(i)))}
                </div>
              </OpenView>
            ) : null}
            {overview ? (
              <div hidden={openIds !== null}>
              <Overview
                stage={target.stage}
                rows={rows}
                sort={sort}
                onSort={(key, dir) => setSort({ key, dir })}
                ticked={ticked}
                onTick={(i, on) => setTicked((t) => (on ? [...t, i] : t.filter((x) => x !== i)))}
                onClear={() => setTicked([])}
                onRead={(from) => openRecipes([...ticked].sort((a, b) => a - b), from)}
                onOpen={(i, from) => openRecipes(besideBase(i), from)}
                onChange={changeThis}
                fit={side.fit}
                narrow={side.narrow}
                goldKnown={golds !== null}
                top={top}
                baseAt={baseAt}
                baseName={runBase}
              />
              </div>
            ) : null}
            {overview || fitAll ? null : (
              <div className="flex border-b border-hairline px-3 py-2">
                <SegmentedControl
                  label="Recipe shown"
                  options={submittedNames.map((n, i) => ({ value: String(i), label: n.short + STATE_SUFFIX[statuses[i]?.kind ?? "done"] }))}
                  value={String(shown)}
                  onChange={(v) => setChosen(Number(v))}
                />
              </div>
            )}

            {overview ? null : (
            <div data-testid="recipe-grid" className="grid gap-px bg-hairline" style={grid}>
              {visible.map((i) => renderColumn(i, null))}
            </div>
            )}
            {note ? <p className="px-3 py-3 text-sm text-fg-muted">{note}</p> : null}
          </>
        )}
      </div>
    </main>
  )
}

export function VariantResult({
  state,
  pending,
  node,
  type,
  data,
  status,
  chunks,
  agreement,
  embeddings,
  hits,
  answer = null,
}: {
  state?: VariantState
  pending: boolean
  node: GraphNode
  type: string
  data?: unknown
  status: InspectorStatus
  chunks?: unknown
  /** How this recipe's top 5 differs from the baseline's, in a sentence: the finding a run is for. */
  agreement: string | null
  /** `384 embedded, 0 from cache`, when the index descriptor reports it. */
  embeddings: string | null
  /** The output's ranked hits, when it is a search: the column then reads as evidence. */
  hits?: HitRowData[] | null
  /** The chunk id of the piece that holds the known answer. */
  answer?: string | null
}) {
  const n = state?.nodes[node.id]
  const failed = state ? Object.values(state.nodes).find((x) => x.status === "failed") : undefined

  let body
  let evidence = false
  if (!pending) {
    body = <EmptyState title="Not run yet">Press Run to run this recipe.</EmptyState>
  } else if (failed && (!n || n.status !== "done")) {
    body = (
      <div role="alert" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-danger">This recipe failed at {failed.id}</p>
        <p className="font-mono text-xs break-words text-fg-muted">{errorHeadline(failed.error ?? "")}</p>
        <details className="rounded-control border border-hairline">
          <summary className="flex h-row-compact items-center px-2 text-xs text-fg-muted select-none hover:bg-muted">Traceback</summary>
          <pre className="m-0 max-h-[240px] overflow-auto border-t border-hairline p-2 font-mono text-2xs text-fg-muted">{failed.error}</pre>
        </details>
      </div>
    )
  } else if (!n || n.status === "pending" || n.status === "running") {
    body = (
      <p role="status" className="text-sm text-fg-muted">
        {state ? "Running" : "Waiting for earlier recipes"}
      </p>
    )
  } else if (n.status === "skipped") {
    body = <EmptyState title="Skipped">A step above it failed, or the run was cancelled.</EmptyState>
  } else if (type === "chunk_set" && status.kind === "ready" && Array.isArray((data as ChunkSet | undefined)?.chunks)) {
    body = <ChunkEvidence set={data as ChunkSet} />
  } else if (hits && status.kind === "ready") {
    evidence = true
    body = <RetrieveEvidence rows={hits} chunkSet={chunks as ChunkSet | undefined} agreement={agreement} answer={answer} />
  } else {
    body = <ArtifactInspector type={type} data={data} status={status} context={chunks ? { chunks: chunks as never } : undefined} />
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(agreement && !evidence) || embeddings ? (
        <p className="flex flex-wrap items-baseline gap-x-4 text-sm">
          {agreement && !evidence ? (
            <span data-testid="agreement" className="font-medium text-fg">
              <MonoNumbers text={agreement} />
            </span>
          ) : null}
          {embeddings ? (
            <span data-testid="embeddings" className="text-xs text-fg-muted">
              {embeddings}
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="min-w-0">{body}</div>
    </div>
  )
}
