import type { ChunkSet } from "@/api/types"
import { loadPayload } from "@/api/useArtifact"
import { v2 } from "@/api/v2"
import { errorHeadline } from "@/state/pipeline"

/**
 * Run the REAL chunker through the run API, only as far as the chunk step:
 * the sample, its parse, and one chunker. Results are cached on the server, so
 * a repeat of the same settings is fast. The run is followed by polling its
 * snapshot, which is simpler than a stream for a run this short.
 */

export interface ChunkRunOptions {
  sha: string
  parse: { transform: string; config: Record<string, unknown> }
  strategy: string
  config: Record<string, unknown>
  pollMs?: number
}

/** The index a pipeline file needs to be valid. The run stops at chunk, so it never runs. */
const LESSON_INDEX = { embed: { use: "qwen3-embedding-0.6b" }, store: { use: "lancedb" } }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runChunks(o: ChunkRunOptions): Promise<ChunkSet> {
  const config = {
    index: { parse: { use: o.parse.transform, ...o.parse.config }, chunk: { use: o.strategy, ...o.config }, ...LESSON_INDEX },
  }
  const { run_id } = await v2.createRun({ config, documents: [o.sha], through: "chunk" })
  for (;;) {
    const snap = await v2.run(run_id)
    if (snap.status !== "running") {
      const done = snap.events.find((e) => e.event === "node_finished" && (e as { step?: unknown }).step === "chunk")
      if (done && typeof done.artifact_id === "string") return (await loadPayload(done.artifact_id)) as ChunkSet
      const failed = snap.events.find((e) => e.event === "node_failed" || e.event === "run_error")
      const error = failed && typeof (failed as { error?: unknown }).error === "string" ? (failed as { error: string }).error : "The chunker did not finish."
      throw new Error(errorHeadline(error))
    }
    await wait(o.pollMs ?? 300)
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
