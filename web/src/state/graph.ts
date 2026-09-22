import type { Graph, GraphEdge, GraphNode, Registry, Stage, TransformInfo } from "@/api/types"
import { defaultsFor } from "@/components/fields/schema"

/**
 * The pipeline as a graph: nodes and port-typed edges, exactly what
 * `POST /api/runs` executes. This is the source of truth for the Build page.
 * The column is one rendering of it (a topological walk); a future canvas can
 * render the same state without translating from a list of form values.
 *
 * Every function here is pure and returns a new graph.
 */

export type PipelineGraph = Graph

/**
 * The column, top to bottom (plan I-7). Clean and Rerank are stackable and
 * removable; the rest appear once.
 */
export const COLUMN_STAGES: Stage[] = ["source", "parse", "clean", "chunk", "index", "query", "retrieve", "rerank", "use_case"]

/** Stages a new graph starts with. Clean and Rerank are added by the user. */
export const DEFAULT_STAGES: Stage[] = ["source", "parse", "chunk", "index", "query", "retrieve", "use_case"]

export const STAGE_VERB: Partial<Record<Stage, string>> = {
  source: "Load",
  parse: "Parse",
  clean: "Clean",
  chunk: "Chunk",
  index: "Index",
  query: "Ask",
  retrieve: "Retrieve",
  rerank: "Rerank",
  use_case: "Search",
}

function stageRank(stage: Stage): number {
  const i = COLUMN_STAGES.indexOf(stage)
  return i === -1 ? COLUMN_STAGES.length : i
}

/**
 * A card's title. Every stage is a plain verb, except the use case: that stage
 * is whatever the pipeline is for, and its transform's name is already the
 * verb (`search` today, `chat` later), so the card says what it does.
 */
export function titleFor(node: Pick<GraphNode, "stage" | "transform">): string {
  if (node.stage === "use_case" && node.transform) {
    const t = node.transform.replace(/_/g, " ")
    return t.charAt(0).toUpperCase() + t.slice(1)
  }
  return STAGE_VERB[node.stage] ?? node.stage
}

export function transformsFor(registry: Registry, stage: Stage): TransformInfo[] {
  return Object.values(registry[stage] ?? {})
}

export function infoFor(registry: Registry, node: Pick<GraphNode, "stage" | "transform">): TransformInfo | undefined {
  return registry[node.stage]?.[node.transform]
}

export function defaultConfig(info: TransformInfo): Record<string, unknown> {
  return defaultsFor(info.config_schema, info.config_schema)
}

/**
 * Transforms a new graph prefers when the live registry has them. Docling is
 * layout-aware, so it is the better first parse. Hybrid RRF fuses the dense and
 * lexical rankings, so its hits carry both component scores and the inspector
 * shows both. Absent, the stage's first registered transform is used.
 */
export const PREFERRED_DEFAULT: Partial<Record<Stage, string>> = { parse: "docling", retrieve: "hybrid_rrf", use_case: "search" }

function defaultTransform(registry: Registry, stage: Stage): TransformInfo | undefined {
  const preferred = PREFERRED_DEFAULT[stage]
  return (preferred && registry[stage]?.[preferred]) || transformsFor(registry, stage)[0]
}

function makeNode(registry: Registry, id: string, stage: Stage, transform?: string): GraphNode | null {
  const info = transform ? registry[stage]?.[transform] : defaultTransform(registry, stage)
  if (!info) return null
  return { id, stage, transform: info.name, config: stage === "source" ? {} : defaultConfig(info) }
}

/**
 * The name of `dst`'s input port that accepts `src`'s output, read from the
 * registry's declared ports. Ambient ports (a query) are never wired by the
 * column.
 */
export function portFor(registry: Registry, src: GraphNode, dst: GraphNode): string | null {
  const out = infoFor(registry, src)?.output
  const inputs = infoFor(registry, dst)?.inputs ?? {}
  const hit = Object.entries(inputs).find(([, p]) => !p.ambient && p.type === out)
  return hit ? hit[0] : null
}

/**
 * Wire every explicit input port that has no edge yet from the nearest card
 * above it in the column whose output is that port's type (plan I-7). Ambient
 * ports get no edge: the server binds them.
 */
export function wire(g: PipelineGraph, registry: Registry): PipelineGraph {
  const order = columnOrder(g)
  const added: GraphEdge[] = []
  order.forEach((dst, i) => {
    const inputs = infoFor(registry, dst)?.inputs ?? {}
    for (const [port, spec] of Object.entries(inputs)) {
      if (spec.ambient || g.edges.some((e) => e.dst === dst.id && e.port === port)) continue
      const src = order
        .slice(0, i)
        .reverse()
        .find((n) => infoFor(registry, n)?.output === spec.type)
      if (src) added.push({ src: src.id, dst: dst.id, port })
    }
  })
  return added.length ? { ...g, edges: [...g.edges, ...added] } : g
}

/** The default column for this registry, wired. Stages it lacks are skipped. */
export function initialGraph(registry: Registry): PipelineGraph {
  const nodes = DEFAULT_STAGES.map((stage) => makeNode(registry, stage, stage)).filter((n): n is GraphNode => n !== null)
  return wire({ nodes, edges: [] }, registry)
}

/** The question the sample graph's Ask card starts with (plan I-15). */
export const SAMPLE_QUESTION = "Why do chunk boundaries matter?"

/** The transform each stage of the sample graph uses. Clean is added to the default column. */
const SAMPLE_TRANSFORMS: Partial<Record<Stage, string>> = {
  parse: "docling",
  clean: "dedupe_blocks",
  chunk: "recursive_character",
  retrieve: "hybrid_rrf",
  use_case: "search",
}

/**
 * The graph "Try the sample document" sets (plan I-15): the default column plus
 * a duplicate-block cleaner (Docling already drops page headers and footers), with the sample source selected, the Qwen3 embedder
 * and the question filled in. Every other setting is its schema default. A
 * transform the registry lacks keeps the stage's default.
 */
export function sampleGraph(registry: Registry, source: { sha: string; filename: string }): PipelineGraph {
  let g = addCleaner(initialGraph(registry), registry)
  for (const n of g.nodes) {
    const t = SAMPLE_TRANSFORMS[n.stage]
    if (t && registry[n.stage]?.[t]) g = setTransform(g, n.id, t, registry)
  }
  const extra: Partial<Record<Stage, Record<string, unknown>>> = {
    source: { sha: source.sha, filename: source.filename },
    // Smaller chunks, so the 3-page sample gives retrieval a pool larger than search shows.
    chunk: { chunk_size: 400, chunk_overlap: 80 },
    index: { embedder: "qwen3-embedding-0.6b" },
    query: { text: SAMPLE_QUESTION },
  }
  return { ...g, nodes: g.nodes.map((n) => (extra[n.stage] ? { ...n, config: { ...n.config, ...extra[n.stage] } } : n)) }
}

/**
 * Add any default stage a stored graph lacks (one saved before retrieval
 * existed), then wire the new cards. A complete graph comes back unchanged.
 */
export function completeGraph(g: PipelineGraph, registry: Registry): PipelineGraph {
  const have = new Set(g.nodes.map((n) => n.stage))
  let next = g
  for (const stage of DEFAULT_STAGES) {
    if (have.has(stage)) continue
    const id = next.nodes.some((n) => n.id === stage) ? freshId(next, stage) : stage
    const node = makeNode(registry, id, stage)
    if (node) next = { nodes: [...next.nodes, node], edges: next.edges }
  }
  return next === g ? g : wire(next, registry)
}

/**
 * Column order: a topological walk (Kahn, ties by insertion order), then a
 * stable sort by stage. The sort is what puts Ask, which has no edges at all,
 * between Index and Retrieve; within a stage, a stack keeps its edge order.
 */
export function columnOrder(g: PipelineGraph): GraphNode[] {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]))
  for (const e of g.edges) indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const out: GraphNode[] = []
  const ready = g.nodes.filter((n) => indeg.get(n.id) === 0)
  while (ready.length) {
    const n = ready.shift()!
    out.push(n)
    for (const e of g.edges.filter((x) => x.src === n.id)) {
      const d = (indeg.get(e.dst) ?? 0) - 1
      indeg.set(e.dst, d)
      if (d === 0 && byId.has(e.dst)) ready.push(byId.get(e.dst)!)
    }
  }
  // A cycle should never exist; if it does, still show every node.
  for (const n of g.nodes) if (!out.includes(n)) out.push(n)
  return out
    .map((n, i) => [n, i] as const)
    .sort((a, b) => stageRank(a[0].stage) - stageRank(b[0].stage) || a[1] - b[1])
    .map(([n]) => n)
}

function freshId(g: PipelineGraph, prefix: string): string {
  const ids = new Set(g.nodes.map((n) => n.id))
  let i = 1
  while (ids.has(`${prefix}_${i}`)) i += 1
  return `${prefix}_${i}`
}

/**
 * Insert a node of a stackable stage after the last node of that stage or,
 * when there is none, after the last card above it that feeds it (Parse for a
 * cleaner, Retrieve for a reranker). Edges that left that anchor carrying the
 * new node's output type now leave the new node, on the same ports. Picks the
 * first transform not already in the stack.
 */
export function addStacked(g: PipelineGraph, registry: Registry, stage: Stage): PipelineGraph {
  const choices = transformsFor(registry, stage)
  const used = new Set(g.nodes.filter((n) => n.stage === stage).map((n) => n.transform))
  const pick = choices.find((c) => !used.has(c.name)) ?? choices[0]
  if (!pick) return g
  const order = columnOrder(g)
  const anchor = [...order]
    .reverse()
    .find((n) => stageRank(n.stage) <= stageRank(stage) && infoFor(registry, n)?.output === pick.output)
  if (!anchor) return g
  const node = makeNode(registry, freshId(g, stage), stage, pick.name)!
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const moves = (e: GraphEdge) => {
    const dst = byId.get(e.dst)
    return e.src === anchor.id && dst !== undefined && infoFor(registry, dst)?.inputs[e.port]?.type === pick.output
  }
  const port = portFor(registry, anchor, node)
  const edges = [
    ...g.edges.filter((e) => !moves(e)),
    ...(port ? [{ src: anchor.id, dst: node.id, port }] : []),
    ...g.edges.filter(moves).map((e) => ({ ...e, src: node.id })),
  ]
  const at = g.nodes.indexOf(anchor) + 1
  return { nodes: [...g.nodes.slice(0, at), node, ...g.nodes.slice(at)], edges }
}

/** A cleaner between Parse (or the last cleaner) and Chunk. */
export const addCleaner = (g: PipelineGraph, registry: Registry) => addStacked(g, registry, "clean")

/** A reranker between Retrieve (or the last reranker) and Search. */
export const addReranker = (g: PipelineGraph, registry: Registry) => addStacked(g, registry, "rerank")

/**
 * Remove a node and bridge the gap: each of its consumers is fed by its
 * (single) producer instead, on the consumer's own port. Meant for endomorphic
 * nodes such as cleaners and rerankers, where input and output types match.
 */
export function removeNode(g: PipelineGraph, id: string): PipelineGraph {
  const incoming = g.edges.filter((e) => e.dst === id)
  const outgoing = g.edges.filter((e) => e.src === id)
  const producer = incoming.length === 1 ? incoming[0].src : null
  const bridged = producer ? outgoing.map((e) => ({ ...e, src: producer })) : []
  return {
    nodes: g.nodes.filter((n) => n.id !== id),
    edges: [...g.edges.filter((e) => e.src !== id && e.dst !== id), ...bridged],
  }
}

/** Swap a node's transform: config resets to its defaults, ports are re-read. */
export function setTransform(g: PipelineGraph, id: string, transform: string, registry: Registry): PipelineGraph {
  const old = g.nodes.find((n) => n.id === id)
  if (!old || old.transform === transform) return g
  const next = makeNode(registry, id, old.stage, transform)
  if (!next) return g
  if (old.stage === "source") next.config = old.config
  const nodes = g.nodes.map((n) => (n.id === id ? next : n))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = g.edges.map((e) => {
    if (e.dst !== id) return e
    const port = portFor(registry, byId.get(e.src)!, next)
    return port ? { ...e, port } : e
  })
  return { nodes, edges }
}

export function setConfig(g: PipelineGraph, id: string, config: Record<string, unknown>): PipelineGraph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, config } : n)) }
}

/**
 * What the server binds each unwired ambient port of `id` to: the unique
 * terminal producer of the port's type that is neither `id` nor one of its
 * descendants (core/graph.py). Nothing when there is none, or more than one.
 */
export function ambientSources(g: PipelineGraph, registry: Registry, id: string): string[] {
  const node = g.nodes.find((n) => n.id === id)
  const inputs = node ? (infoFor(registry, node)?.inputs ?? {}) : {}
  const blocked = new Set([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of g.edges) {
      if (e.src === cur && !blocked.has(e.dst)) {
        blocked.add(e.dst)
        stack.push(e.dst)
      }
    }
  }
  const out: string[] = []
  for (const [port, spec] of Object.entries(inputs)) {
    if (!spec.ambient || g.edges.some((e) => e.dst === id && e.port === port)) continue
    const candidates = new Set(g.nodes.filter((n) => !blocked.has(n.id) && infoFor(registry, n)?.output === spec.type).map((n) => n.id))
    const terminal = [...candidates].filter((c) => !g.edges.some((e) => e.src === c && candidates.has(e.dst)))
    if (terminal.length === 1) out.push(terminal[0])
  }
  return out
}

/**
 * Every node `id` depends on. Given the registry, ambient bindings count too:
 * Retrieve depends on Ask although no edge says so.
 */
export function ancestors(g: PipelineGraph, id: string, registry?: Registry): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    const parents = g.edges.filter((e) => e.dst === cur).map((e) => e.src)
    if (registry) parents.push(...ambientSources(g, registry, cur))
    for (const p of parents) {
      if (!out.has(p)) {
        out.add(p)
        stack.push(p)
      }
    }
  }
  return out
}

/** The nearest strict ancestor of `id` on `stage` (or any of `stage`), walking producer edges. */
export function upstreamOfStage(g: PipelineGraph, id: string, stage: Stage | readonly Stage[]): GraphNode | undefined {
  const want: readonly Stage[] = typeof stage === "string" ? [stage] : stage
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  let frontier = g.edges.filter((e) => e.dst === id).map((e) => e.src)
  const seen = new Set<string>()
  while (frontier.length) {
    const hit = frontier.map((x) => byId.get(x)).find((n) => n !== undefined && want.includes(n.stage))
    if (hit) return hit
    frontier.forEach((x) => seen.add(x))
    frontier = g.edges.filter((e) => frontier.includes(e.dst) && !seen.has(e.src)).map((e) => e.src)
  }
  return undefined
}

/** The last card of the column: the use case, the node a question runs through. */
export function terminalNode(g: PipelineGraph): GraphNode | undefined {
  const order = columnOrder(g)
  return order.find((n) => n.stage === "use_case") ?? order[order.length - 1]
}

/**
 * Identity of a node's output as the column last saw it: its transform and
 * config and those of every ancestor (ambient ones too, given the registry).
 * When this changes, a stored result is stale.
 */
export function signature(g: PipelineGraph, id: string, registry?: Registry): string {
  const ids = [...ancestors(g, id, registry), id].sort()
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  return JSON.stringify(ids.map((x) => [x, byId.get(x)?.transform, byId.get(x)?.config]))
}

/**
 * Parse a stored graph; null unless every node still names a known transform.
 * A graph stored before retrieval existed is completed with the new cards.
 */
export function loadGraph(raw: string | null, registry: Registry): PipelineGraph | null {
  if (!raw) return null
  try {
    const g = JSON.parse(raw) as PipelineGraph
    if (!Array.isArray(g?.nodes) || !Array.isArray(g?.edges)) return null
    if (!g.nodes.every((n) => typeof n.id === "string" && registry[n.stage]?.[n.transform])) return null
    const ids = new Set(g.nodes.map((n) => n.id))
    if (!g.edges.every((e) => ids.has(e.src) && ids.has(e.dst) && typeof e.port === "string")) return null
    return completeGraph(g, registry)
  } catch {
    return null
  }
}

const STORAGE_KEY = "rag-playground:graph:v1"

/** The graph is shared between Build and Compare through per-viewer storage. */
export function readStoredGraph(registry: Registry): PipelineGraph | null {
  try {
    return loadGraph(window.localStorage.getItem(STORAGE_KEY), registry)
  } catch {
    return null
  }
}

export function storeGraph(g: PipelineGraph): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(g))
  } catch {
    // Private window or blocked storage: the page still works, it just forgets.
  }
}
