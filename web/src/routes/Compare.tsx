import { useId, useMemo, useRef, useState, type CSSProperties } from "react"
import { Plus } from "lucide-react"

import { useApiKey } from "@/api/apiKey"
import { api } from "@/api/client"
import type { NodeState, VariantState } from "@/api/runState"
import type { GraphNode, Registry, TransformInfo, Variant } from "@/api/types"
import { usePayloads } from "@/api/usePayloads"
import { useRegistry } from "@/api/useRegistry"
import { useRun } from "@/api/useRun"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { EmptyState } from "@/components/EmptyState"
import { CONTROL } from "@/components/fields/types"
import { agreementText, compareLists, hitIds } from "@/components/inspectors/hits"
import { embeddingCounts, type IndexDescriptor } from "@/components/inspectors/IndexInspector"
import { ArtifactInspector } from "@/components/inspectors/registry"
import type { InspectorStatus } from "@/components/inspectors/status"
import { fmtMs } from "@/components/pipeline/NodeCard"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { SweepControl } from "@/components/SweepControl"
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
import { errorHeadline, routeRunError } from "@/state/pipeline"
import { baselineIndex, matryoshkaVariants, tallyLine, tallySweep, variantLabels, variantName, type VariantLabel } from "@/state/sweep"

import { RegistryScreen } from "./Shell"
import { useColumnsFit } from "./useColumnsFit"

/**
 * Compare: sweep one node of the Build pipeline over N variants and show the
 * results side by side. Each variant sits in its own column, its editor above
 * the output of the node the sweep runs through, so a config and what it
 * produced read together. Where the columns do not fit side by side, one
 * recipe shows at a time, chosen above the grid.
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
  // What the picker offers: Parse and Chunk, plus the target when it is another stage
  // (Build's Sweep button opens Index or Retrieve here), so it always shows the target.
  const choices = graph.nodes.filter((n) => n.stage === "parse" || n.stage === "chunk")
  if (!choices.includes(target)) choices.push(target)
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
  const stageId = useId()
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
  const hitLists = ids.map((x) => hitIds(payload(x.through).data))
  const base = run.closed ? baselineIndex(submitted.variants, (i) => (hitLists[i]?.length ?? 0) > 0) : null
  // A Matryoshka baseline is named by the width its index was built at, which
  // the descriptor knows even when the variant asked for "native".
  const baseDim = base === null ? undefined : (payload(ids[base]?.index).data as IndexDescriptor | undefined)?.dim
  const baseName = base === null ? "" : plainName(submitted.variants, base, target.stage, labels, baseDim)
  // The question a sweep answers, when the step it runs through reads it.
  const query = graph.nodes.find((n) => n.stage === "query")
  const question = query && ancestors(graph, through, registry).has(query.id) ? String(query.config.text ?? "") : ""

  async function sweep() {
    setError(null)
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
      setSubmitted({ variants, through })
      setRunId(run_id)
    } catch (err) {
      const routed = routeRunError(err, graph)
      setError(
        routed.kind === "fields"
          ? `${routed.nodeId}: ` + Object.entries(routed.errors).map(([k, m]) => `${k} ${m.join(", ")}`).join("; ")
          : routed.message,
      )
    } finally {
      setSubmitting(false)
    }
  }

  const reshape = (next: Variant[]) => {
    setVariants(next)
    // A different number of variants no longer lines up with the results.
    if (next.length !== variants.length) {
      setRunId(null)
      setSubmitted({ variants: [], through })
    }
  }

  const visible = fit ? variants.map((_, i) => i) : [shown]
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${Math.max(visible.length, 1)}, minmax(0, 1fr))` }
  const tabLabels = variantLabels(variants, registry, target.stage)
  const running = run.variants.length > 0 && !run.closed ? run.variants[run.variants.length - 1].index : null
  const verb = titleFor(target)

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex min-h-row shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-3 py-1">
        <div className="flex min-w-0 basis-full items-baseline gap-3 md:basis-auto">
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
                <a href="/build" className="text-fg underline">
                  Change the question on Build
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="flex items-center gap-2">
            <label htmlFor={stageId} className="text-sm text-fg-muted">
              Compare
            </label>
            <select id={stageId} className={`${CONTROL} w-auto min-w-[10rem]`} value={target.id} disabled={busy} onChange={(e) => onChoose(e.target.value)}>
              {choices.map((n) => (
                <option key={n.id} value={n.id}>
                  {titleFor(n)}
                </option>
              ))}
            </select>
          </div>
          {/* Parse and Chunk columns show their own output; only a later stage has a choice of where to stop. */}
          {downstream.length > 1 && target.stage !== "parse" && target.stage !== "chunk" ? (
            <div className="flex items-center gap-2">
              <label htmlFor={throughId} className="text-sm text-fg-muted">
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
              reshape([...variants, { transform: transforms[0].name, config: defaultConfig(transforms[0]) }])
              // Where one recipe shows at a time, show the new one.
              setChosen(variants.length)
            }}
          >
            <Plus aria-hidden strokeWidth={1.75} />
            Add variant
          </Button>
          {/* Below sm the run buttons take their own full-width row, so Sweep is never pushed off a phone screen. */}
          <div className="flex basis-full gap-2 sm:basis-auto">
            {busy && runId ? (
              <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => void api.cancelRun(runId).catch(() => undefined)}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" className="flex-1 sm:flex-none" disabled={busy || variants.length === 0} onClick={() => void sweep()}>
              {busy ? "Sweeping" : `Sweep ${variants.length} ${variants.length === 1 ? "variant" : "variants"}`}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-row shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline px-3 py-2" aria-live="polite">
        {error ? (
          <p role="alert" className="font-mono text-xs break-words text-danger">
            {error}
          </p>
        ) : tally ? (
          <>
            <p data-testid="tally" className="text-sm text-fg">
              <MonoNumbers text={tallyLine(tally, order.map((n) => ({ id: n.id, title: titleFor(n) })))} />
            </p>
            <p className="text-xs text-fg-muted">
              {running !== null ? `Running variant ${running + 1} of ${submitted.variants.length}.` : run.closed ? "Steps above the swept one ran once; the rest came from the cache." : "Starting."}
            </p>
            {run.error ? <p className="font-mono text-xs text-danger">{errorHeadline(run.error)}</p> : null}
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Each variant runs the pipeline through the {titleFor(graph.nodes.find((n) => n.id === through) ?? target)} step. Steps above {verb} are shared, so they run once and the rest come from the cache.
          </p>
        )}
      </div>

      {fit ? null : (
        <div className="flex shrink-0 border-b border-hairline px-3 py-2">
          <SegmentedControl
            label="Recipe shown"
            options={tabLabels.map((l, i) => ({ value: String(i), label: l.fields.length ? `${l.transform} ${l.fields[0][1]}` : l.transform }))}
            value={String(shown)}
            onChange={(v) => setChosen(Number(v))}
          />
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div data-testid="recipe-grid" className="grid gap-px bg-hairline" style={grid}>
          {visible.map((i) => (
            <SweepControl
              key={i}
              variant={variants[i]}
              transforms={transforms}
              changed={submitted.variants[i] !== undefined && !same(submitted.variants[i], variants[i])}
              onChange={(nv) => setVariants(variants.map((x, j) => (j === i ? nv : x)))}
              onRemove={variants.length > 1 && !busy ? () => reshape(variants.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          {visible.map((i) => {
            const s = stateOf(i)
            const out = payload(ids[i]?.through)
            const chunks = payload(ids[i]?.chunks)
            const descriptor = payload(ids[i]?.index).data as IndexDescriptor | undefined
            const agreement =
              base !== null && i !== base && hitLists[i] && hitLists[base] ? agreementText(compareLists(hitLists[base]!, hitLists[i]!), baseName) : null
            return (
              <VariantResult
                key={i}
                state={s}
                pending={runId !== null && i < submitted.variants.length}
                label={labels[i]}
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
                embeddings={embeddingCounts(descriptor)}
              />
            )
          })}
        </div>
      </div>
    </main>
  )
}

export function VariantResult({
  state,
  pending,
  label,
  node,
  type,
  data,
  status,
  chunks,
  agreement,
  embeddings,
}: {
  state?: VariantState
  pending: boolean
  label?: VariantLabel
  node: GraphNode
  type: string
  data?: unknown
  status: InspectorStatus
  chunks?: unknown
  /** How this variant's top 5 differs from the baseline's, in a sentence: the finding a sweep is for. */
  agreement: string | null
  /** `384 embedded, 0 from cache`, when the index descriptor reports it. */
  embeddings: string | null
}) {
  const n = state?.nodes[node.id]
  const failed = state ? Object.values(state.nodes).find((x) => x.status === "failed") : undefined

  let body
  if (!pending) {
    body = <EmptyState title="Not swept yet">Press Sweep to run this variant.</EmptyState>
  } else if (failed && (!n || n.status !== "done")) {
    body = (
      <div role="alert" className="flex flex-col gap-1 p-4">
        <p className="text-sm font-medium text-danger">This variant failed at {failed.id}</p>
        <p className="font-mono text-xs break-words text-fg-muted">{errorHeadline(failed.error ?? "")}</p>
        <details className="rounded-control border border-hairline">
          <summary className="flex h-row-compact items-center px-2 text-xs text-fg-muted select-none hover:bg-muted">Traceback</summary>
          <pre className="m-0 max-h-[240px] overflow-auto border-t border-hairline p-2 font-mono text-2xs text-fg-muted">{failed.error}</pre>
        </details>
      </div>
    )
  } else if (!n || n.status === "pending" || n.status === "running") {
    body = (
      <p role="status" className="p-4 text-sm text-fg-muted">
        {state ? "Running" : "Waiting for earlier variants"}
      </p>
    )
  } else if (n.status === "skipped") {
    body = <EmptyState title="Skipped">A step above it failed, or the sweep was cancelled.</EmptyState>
  } else {
    body = <ArtifactInspector type={type} data={data} status={status} context={chunks ? { chunks: chunks as never } : undefined} />
  }

  return (
    <section aria-label={`Result ${label?.transform ?? ""}`} className="flex min-w-0 flex-col bg-surface">
      {label ? (
        <header className="flex min-h-row flex-col justify-center gap-1 border-b border-hairline px-3 py-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
              <h2 className="font-mono text-sm font-semibold">{label.transform}</h2>
              {label.fields.map(([k, v]) => (
                <span key={k} className="font-mono text-xs text-fg-muted">
                  {k} <span className="text-fg">{v}</span>
                </span>
              ))}
            </div>
            {finished(n) ? (
              <span className="text-xs text-fg-muted">
                {titleFor(node)} {n!.cache_hit ? "cached" : "computed"} <span className="font-mono">{fmtMs(n!.duration_ms)}</span>
              </span>
            ) : null}
          </div>
          {agreement || embeddings ? (
            <p className="flex flex-wrap items-baseline gap-x-4 text-sm">
              {agreement ? (
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
        </header>
      ) : null}
      <div className="min-w-0 p-3">{body}</div>
    </section>
  )
}
