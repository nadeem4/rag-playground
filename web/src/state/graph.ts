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

/** The stages this phase's column shows, in pipeline order. */
export const COLUMN_STAGES: Stage[] = ["source", "parse", "clean", "chunk"]

export const STAGE_VERB: Partial<Record<Stage, string>> = {
  source: "Load",
  parse: "Parse",
  clean: "Clean",
  chunk: "Chunk",
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
 * layout-aware, so it is the better first parse; absent, the stage's first
 * registered transform is used as before.
 */
export const PREFERRED_DEFAULT: Partial<Record<Stage, string>> = { parse: "docling" }

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

function link(registry: Registry, src: GraphNode, dst: GraphNode): GraphEdge[] {
  const port = portFor(registry, src, dst)
  return port ? [{ src: src.id, dst: dst.id, port }] : []
}

/** Source, parse and chunk, each on its stage's default transform, wired in a chain. */
export function initialGraph(registry: Registry): PipelineGraph {
  const chain = [
    makeNode(registry, "source", "source"),
    makeNode(registry, "parse", "parse"),
    makeNode(registry, "chunk", "chunk"),
  ].filter((n): n is GraphNode => n !== null)
  const edges = chain.slice(1).flatMap((n, i) => link(registry, chain[i], n))
  return { nodes: chain, edges }
}

/** Kahn's algorithm, ties broken by insertion order, so a chain reads top to bottom. */
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
}

function freshId(g: PipelineGraph, prefix: string): string {
  const ids = new Set(g.nodes.map((n) => n.id))
  let i = 1
  while (ids.has(`${prefix}_${i}`)) i += 1
  return `${prefix}_${i}`
}

/**
 * Insert a clean node after the last cleaner (or after parse when there is
 * none). Edges leaving that node now leave the new cleaner instead, on the
 * same ports. Picks the first cleaner not already in the stack.
 */
export function addCleaner(g: PipelineGraph, registry: Registry): PipelineGraph {
  const order = columnOrder(g)
  const anchor = [...order].reverse().find((n) => n.stage === "clean") ?? order.find((n) => n.stage === "parse")
  if (!anchor) return g
  const used = new Set(g.nodes.filter((n) => n.stage === "clean").map((n) => n.transform))
  const choices = transformsFor(registry, "clean")
  const pick = choices.find((c) => !used.has(c.name)) ?? choices[0]
  if (!pick) return g
  const node = makeNode(registry, freshId(g, "clean"), "clean", pick.name)!
  const outgoing = g.edges.filter((e) => e.src === anchor.id)
  const edges = [
    ...g.edges.filter((e) => e.src !== anchor.id),
    ...link(registry, anchor, node),
    ...outgoing.map((e) => ({ ...e, src: node.id })),
  ]
  const at = g.nodes.indexOf(anchor) + 1
  return { nodes: [...g.nodes.slice(0, at), node, ...g.nodes.slice(at)], edges }
}

/**
 * Remove a node and bridge the gap: each of its consumers is fed by its
 * (single) producer instead, on the consumer's own port. Meant for endomorphic
 * nodes such as cleaners, where input and output types match.
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

export function ancestors(g: PipelineGraph, id: string): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of g.edges) {
      if (e.dst === cur && !out.has(e.src)) {
        out.add(e.src)
        stack.push(e.src)
      }
    }
  }
  return out
}

/** The nearest strict ancestor of `id` on `stage`, walking producer edges. */
export function upstreamOfStage(g: PipelineGraph, id: string, stage: Stage): GraphNode | undefined {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  let frontier = g.edges.filter((e) => e.dst === id).map((e) => e.src)
  const seen = new Set<string>()
  while (frontier.length) {
    const hit = frontier.map((x) => byId.get(x)).find((n) => n?.stage === stage)
    if (hit) return hit
    frontier.forEach((x) => seen.add(x))
    frontier = g.edges.filter((e) => frontier.includes(e.dst) && !seen.has(e.src)).map((e) => e.src)
  }
  return undefined
}

/**
 * Identity of a node's output as the column last saw it: its transform and
 * config and those of every ancestor. When this changes, a stored result is
 * stale.
 */
export function signature(g: PipelineGraph, id: string): string {
  const ids = [...ancestors(g, id), id].sort()
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  return JSON.stringify(ids.map((x) => [x, byId.get(x)?.transform, byId.get(x)?.config]))
}

/** Parse a stored graph; null unless every node still names a known transform. */
export function loadGraph(raw: string | null, registry: Registry): PipelineGraph | null {
  if (!raw) return null
  try {
    const g = JSON.parse(raw) as PipelineGraph
    if (!Array.isArray(g?.nodes) || !Array.isArray(g?.edges)) return null
    if (!g.nodes.every((n) => typeof n.id === "string" && registry[n.stage]?.[n.transform])) return null
    const ids = new Set(g.nodes.map((n) => n.id))
    if (!g.edges.every((e) => ids.has(e.src) && ids.has(e.dst) && typeof e.port === "string")) return null
    return g
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
