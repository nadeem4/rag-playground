import { api } from "@/api/client"
import type { ChunkSet, GraphNode, Registry } from "@/api/types"
import { loadPayload } from "@/api/useArtifact"
import { wire } from "@/state/graph"
import { errorHeadline } from "@/state/pipeline"

/**
 * Run the REAL chunker through the run API on a three-node graph: the sample
 * source, its parse, and one chunk node. Runs are cached on the server, so a
 * repeat of the same settings is fast. The run is followed by polling its
 * snapshot, which is simpler than a stream for a run this short.
 */

export interface ChunkRunOptions {
  registry: Registry
  sha: string
  filename?: string
  parse: { transform: string; config: Record<string, unknown> }
  strategy: string
  config: Record<string, unknown>
  pollMs?: number
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runChunks(o: ChunkRunOptions): Promise<ChunkSet> {
  const source = Object.keys(o.registry.source ?? {})[0] ?? "upload"
  const nodes: GraphNode[] = [
    { id: "source", stage: "source", transform: source, config: { sha: o.sha, filename: o.filename ?? "chunking-primer.pdf" } },
    { id: "parse", stage: "parse", transform: o.parse.transform, config: o.parse.config },
    { id: "chunk", stage: "chunk", transform: o.strategy, config: o.config },
  ]
  const graph = wire({ nodes, edges: [] }, o.registry)
  const { run_id } = await api.createRun({ graph, targets: ["chunk"], force: false })
  for (;;) {
    const snap = await api.run(run_id)
    if (snap.status !== "running") {
      const done = snap.events.find((e) => e.event === "node_finished" && e.node_id === "chunk")
      if (done && typeof done.artifact_id === "string") return (await loadPayload(done.artifact_id)) as ChunkSet
      const failed = snap.events.find((e) => e.event === "node_failed" || e.event === "run_error")
      const error = typeof failed?.error === "string" ? errorHeadline(failed.error) : "The chunker did not finish."
      throw new Error(error)
    }
    await wait(o.pollMs ?? 150)
  }
}

const cache = new Map<string, Promise<ChunkSet>>()

/** `runChunks`, once per settings for the session. A failure is not kept. */
export function runChunksOnce(o: ChunkRunOptions): Promise<ChunkSet> {
  const key = JSON.stringify([o.sha, o.parse, o.strategy, o.config])
  let p = cache.get(key)
  if (!p) {
    p = runChunks(o)
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** Tests only. */
export function clearChunkRunCache(): void {
  cache.clear()
}
