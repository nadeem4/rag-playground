import { useId, useMemo, useRef, useState, type CSSProperties } from "react"
import { Plus } from "lucide-react"

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
import { RecipeHead } from "@/components/compare/RecipeHead"
import { RetrieveEvidence } from "@/components/compare/RetrieveEvidence"
import { EmptyState } from "@/components/EmptyState"
import { CONTROL } from "@/components/fields/types"
import { agreementText, compareLists, hitRows, type HitRowData } from "@/components/inspectors/hits"
import { embeddingCounts, type IndexDescriptor } from "@/components/inspectors/IndexInspector"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { chunkStats } from "@/components/inspectors/spans"
import type { InspectorStatus } from "@/components/inspectors/status"
import { transformLabel } from "@/components/pipeline/NodeCard"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { RECIPE_TITLES, SweepControl } from "@/components/SweepControl"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/SegmentedControl"
import {
  ancestors,
  columnOrder,
  defaultConfig,
  infoFor,
  readStoredGraph,
  terminalNode,
  titleFor,
  transformsFor,
  upstreamOfStage,
  type PipelineGraph,
} from "@/state/graph"
import { chunkFinding, recipeNames, rejectedRecipe, retrieveFinding, type Finding } from "@/state/compare"
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { baselineIndex, matryoshkaVariants, tallyLine, tallySweep, variantLabels, variantName, type VariantLabel } from "@/state/sweep"

import { RegistryScreen } from "./Shell"
import { useColumnsFit } from "./useColumnsFit"

/**
 * Compare: run one node of the Build pipeline over N recipes and show the
 * results side by side. Each recipe is a column: its name in words, its
 * editor (folded once a run starts), then the output of the node the run goes
 * through, so a recipe and what it produced read together. Where the columns
 * do not fit side by side, one recipe shows at a time, chosen above the grid.
 */

export function Compare() {
  const reg = useRegistry()
  // The node under comparison: from the URL on arrival, then from the picker.
  const [wanted, setWanted] = useState<string | null>(() => new URLSearchParams(window.location.search).get("node"))
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  const params = new URLSearchParams(window.location.search)
  const graph = readStoredGraph(reg.registry)
  const target = graph?.nodes.find((n) => n.id === wanted) ?? graph?.nodes.find((n) => n.stage === "chunk")
  if (!graph || !target || !graph.nodes.some((n) => n.stage === "source" && n.config.sha)) {
    return (
      <main className="flex min-h-0 flex-1 flex-col bg-surface">
        <EmptyState title="No pipeline to compare">
          Build a pipeline with a file first, then press Sweep on a card.{" "}
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
  const choose = (id: string) => {
    const q = new URLSearchParams(window.location.search)
    q.set("node", id)
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`)
    setWanted(id)
  }
  // Keyed on the target: a new node means fresh variants, no results and `through` back at the node itself.
  return <Sweep key={target.id} registry={reg.registry} graph={graph} target={target} choices={choices} onChoose={choose} preset={preset} native={native} />
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

function Sweep({
  registry,
  graph,
  target,
  choices,
  onChoose,
  preset,
  native,
}: {
  registry: Registry
  graph: PipelineGraph
  target: GraphNode
  /** The nodes the stage picker offers; always includes `target`. */
  choices: GraphNode[]
  onChoose: (id: string) => void
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
  const [variants, setVariants] = useState<Variant[]>(() => (preset ? matryoshkaVariants(target, native) : seedVariants(target, transforms)))
  const [submitted, setSubmitted] = useState<{ variants: Variant[]; through: string }>({ variants: [], through })
  const [runId, setRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { keys } = useApiKey()
  const run = useRun(runId)
  const busy = submitting || (runId !== null && !run.closed)
  const scroller = useRef<HTMLDivElement>(null)
  const fit = useColumnsFit(scroller, Math.max(variants.length, 1))
  // The recipe shown when the columns do not fit, clamped when one is removed.
  const [chosen, setChosen] = useState(0)
  const shown = Math.min(chosen, variants.length - 1)
  // Which editors are unfolded: all of them before the first run, none once Run is pressed.
  const [open, setOpen] = useState<boolean[]>(() => variants.map(() => true))
  const editorId = useId()

  const shownThrough = graph.nodes.find((n) => n.id === submitted.through) ?? target
  const tally = runId ? tallySweep(run.variants) : null
  const labels = variantLabels(submitted.variants, registry, target.stage)
  const upstream = order.filter((n) => n.stage !== "source" && ancestors(graph, target.id, registry).has(n.id) && n.stage !== "query")
  const filename = String(graph.nodes.find((n) => n.stage === "source")?.config.filename ?? "")

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
          return { short: submittedNames[i].short, transform: v.transform, size, stats: chunkStats(set), own: own(v) }
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
    setSubmitting(true)
    setOpen(variants.map(() => false))
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
      setSubmitted({ variants, through })
      setRunId(run_id)
    } catch (err) {
      // The run never started: open the recipe the error belongs to, or every recipe when it cannot be told.
      const routed = routeRunError(err, graph)
      if (routed.kind === "fields") {
        const fields = Object.keys(routed.errors)
        const at = routed.nodeId === target.id ? rejectedRecipe(variants, submitted.variants, fields, target.stage, registry) : null
        const node = graph.nodes.find((x) => x.id === routed.nodeId)
        const schema = at === null ? undefined : infoFor(registry, { stage: target.stage, transform: variants[at].transform })?.config_schema
        const title = (k: string) => RECIPE_TITLES[k] ?? schema?.properties?.[k]?.title ?? k
        const where = at === null ? (node ? titleFor(node) : routed.nodeId) : `Recipe ${at + 1}, ${names[at].name}`
        setError(Object.entries(routed.errors).map(([k, m]) => (k ? `${where}, ${title(k)}: ${m.join(" ")}` : `${where}: ${m.join(" ")}`)).join(" "))
        setOpen(variants.map((_, i) => at === null || i === at))
      } else {
        setError(routed.message)
        setOpen(variants.map(() => true))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const reshape = (next: Variant[], nextOpen: boolean[]) => {
    setVariants(next)
    setOpen(nextOpen)
    // A different number of variants no longer lines up with the results.
    if (next.length !== variants.length) {
      setRunId(null)
      setSubmitted({ variants: [], through })
    }
  }

  const visible = fit ? variants.map((_, i) => i) : [shown]
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${Math.max(visible.length, 1)}, minmax(0, 1fr))` }
  const names = recipeNames(variants, target.stage, registry)
  const own = (v: Variant) => same(v, { transform: target.transform, config: target.config })
  const labelFor = target.stage === "retrieve" ? (name: string) => RETRIEVAL_LABEL[name] ?? name : transformLabel
  const running = run.variants.length > 0 && !run.closed ? run.variants[run.variants.length - 1].index : null
  const verb = titleFor(target)
  const finding = run.closed ? findingFor() : null
  const answerId = (rows: HitRowData[] | null) => {
    const rank = answerRank(rows)
    return rank === null ? null : (rows?.find((r) => r.rank === rank)?.chunk_id ?? null)
  }
  const n = submitted.variants.length
  // On Retrieve every recipe searches the one chunk set, so a colour is the same piece in every column.
  const note =
    finding && target.stage === "retrieve" && searched !== null
      ? `The colours are piece numbers, the same in every column, because ${n === 2 ? "both" : `all ${NUMBER_WORDS[n] ?? n}`} recipes search the same ${searched} ${searched === 1 ? "piece" : "pieces"}.`
      : null

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex min-h-row shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 basis-full flex-wrap items-baseline gap-x-3 md:basis-auto">
          <h1 className="text-xl font-semibold">Compare</h1>
          {/* Wraps rather than truncates, as on Evaluate: the filename stays whole at phone width. */}
          <p className="text-sm text-fg-muted">
            The {verb} step over <span className="font-mono">{filename}</span>
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
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
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
              <select id={throughId} className={`${CONTROL} w-auto min-w-[10rem]`} value={through} disabled={busy} onChange={(e) => setThrough(e.target.value)}>
                {downstream.map((n) => (
                  <option key={n.id} value={n.id}>
                    {titleFor(n)}
                    {n.stage === "clean" || n.stage === "rerank" ? ` ${n.id}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              reshape([...variants, { transform: transforms[0].name, config: defaultConfig(transforms[0]) }], [...open, true])
              // Where one recipe shows at a time, show the new one.
              setChosen(variants.length)
            }}
          >
            <Plus aria-hidden strokeWidth={1.75} />
            Add a recipe
          </Button>
          {/* Below md the run buttons take their own full-width row, so Sweep is never pushed off a phone screen. */}
          <div className="flex basis-full gap-2 md:basis-auto">
            {busy && runId ? (
              <Button variant="outline" size="sm" className="flex-1 md:flex-none" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" className="flex-1 md:flex-none" disabled={busy || variants.length === 0} onClick={() => void sweep()}>
              {busy ? "Running" : `Run ${variants.length} ${variants.length === 1 ? "recipe" : "recipes"}`}
            </Button>
          </div>
        </div>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {/* The finding says what differs before any column does; the tally under it is the quiet fact of what ran. */}
        <div className="flex flex-col gap-1 border-b border-hairline px-3 py-3" aria-live="polite">
          {error ? (
            <p role="alert" className="text-sm break-words text-danger">
              {error}
            </p>
          ) : tally ? (
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
                </>
              ) : null}
              <p data-testid="tally" className="m-0 text-xs text-fg-muted">
                <MonoNumbers text={tallyLine(tally, order.map((n) => ({ id: n.id, title: titleFor(n) })))} />
                {running !== null ? ` Running recipe ${running + 1} of ${submitted.variants.length}.` : run.closed ? "" : " Starting."}
              </p>
              {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
            </>
          ) : (
            <p className="text-sm text-fg-muted">
              Each recipe runs the pipeline through the {titleFor(graph.nodes.find((n) => n.id === through) ?? target)} step. Steps above {verb} are shared, so they run once and the rest come from the cache.
            </p>
          )}
        </div>

        {fit ? null : (
          <div className="flex border-b border-hairline px-3 py-2">
            <SegmentedControl
              label="Recipe shown"
              options={names.map((n, i) => ({ value: String(i), label: n.short }))}
              value={String(shown)}
              onChange={(v) => setChosen(Number(v))}
            />
          </div>
        )}

        <div data-testid="recipe-grid" className="grid gap-px bg-hairline" style={grid}>
          {visible.map((i) => {
            const s = stateOf(i)
            const out = payload(ids[i]?.through)
            const chunks = payload(ids[i]?.chunks)
            const descriptor = payload(ids[i]?.index).data as IndexDescriptor | undefined
            const agreement =
              base !== null && i !== base && hitLists[i] && hitLists[base] ? agreementText(compareLists(hitLists[base]!, hitLists[i]!), baseName) : null
            const unfolded = open[i] ?? true
            return (
              <section key={i} aria-label={names[i].name} className="flex min-w-0 flex-col gap-3 bg-surface p-3">
                <RecipeHead
                  name={names[i].name}
                  code={names[i].code}
                  own={own(variants[i])}
                  edited={submitted.variants[i] !== undefined && !same(submitted.variants[i], variants[i])}
                  open={unfolded}
                  controls={`${editorId}-${i}`}
                  onToggle={() => setOpen(variants.map((_, j) => (j === i ? !unfolded : (open[j] ?? true))))}
                />
                <div id={`${editorId}-${i}`}>
                  {unfolded ? (
                    <SweepControl
                      variant={variants[i]}
                      transforms={transforms}
                      labelFor={labelFor}
                      onChange={(nv) => setVariants(variants.map((x, j) => (j === i ? nv : x)))}
                      onRemove={
                        variants.length > 1 && !busy
                          ? () =>
                              reshape(
                                variants.filter((_, j) => j !== i),
                                variants.map((_, j) => open[j] ?? true).filter((_, j) => j !== i),
                              )
                          : undefined
                      }
                    />
                  ) : null}
                </div>
                <VariantResult
                  state={s}
                  pending={runId !== null && i < submitted.variants.length}
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
                    agreement ?? (i === base && hitLists.some((h, j) => j !== i && h) ? "The baseline. The other recipes are read against this list." : null)
                  }
                  embeddings={target.stage === "index" ? embeddingCounts(descriptor) : null}
                  hits={hitRowLists[i]}
                  answer={answerId(hitRowLists[i])}
                />
              </section>
            )
          })}
        </div>
        {note ? <p className="px-3 py-3 text-sm text-fg-muted">{note}</p> : null}
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
