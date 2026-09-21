import { describe, expect, it } from "vitest"

import { reduceEvents } from "@/api/runState"
import type { RunEvent } from "@/api/types"

import { baselineIndex, matryoshkaVariants, tallyLine, tallySweep, variantLabels, variantName } from "./sweep"
import { TEST_REGISTRY as R } from "./testRegistry"

const NODES = ["source", "parse", "chunk"]

/** One sweep variant's block, as `core.executor.sweep` emits it. */
function variantBlock(index: number, transform: string, hits: Record<string, boolean>): RunEvent[] {
  const out: RunEvent[] = [
    { event: "variant_started", ts: 0, index, variant: { transform, config: {} } },
    { event: "run_started", ts: 0, nodes: NODES, selected: NODES },
  ]
  for (const id of NODES) {
    out.push({ event: "node_started", ts: 0, node_id: id, transform: id === "chunk" ? transform : id, artifact_id: `${id}-${index}` })
    out.push({ event: "node_finished", ts: 0, node_id: id, artifact_id: `${id}-${index}`, cache_hit: hits[id], duration_ms: 1 })
  }
  out.push({ event: "run_finished", ts: 0, ok: true })
  out.push({ event: "variant_finished", ts: 0, index, ok: true })
  return out
}

describe("sweep grouping", () => {
  it("groups node events by the latest variant_started, although node ids repeat", () => {
    const events = [
      ...variantBlock(0, "recursive_character", { source: false, parse: false, chunk: false }),
      ...variantBlock(1, "markdown_header", { source: true, parse: true, chunk: false }),
      { event: "stream_end", ts: 0, status: "finished", ok: true } as RunEvent,
    ]
    const state = reduceEvents(events)
    expect(state.variants.map((v) => v.index)).toEqual([0, 1])
    expect(state.variants.map((v) => v.variant?.transform)).toEqual(["recursive_character", "markdown_header"])
    expect(state.variants.map((v) => v.nodes.chunk.artifact_id)).toEqual(["chunk-0", "chunk-1"])
    expect(state.variants.map((v) => v.nodes.parse.status)).toEqual(["done", "cached"])
  })
})

const COLUMN = [
  { id: "source", title: "Load" },
  { id: "parse", title: "Parse" },
  { id: "chunk", title: "Chunk" },
]

describe("tallySweep", () => {
  it("counts executions per node from node_finished cache_hit:false, not variants", () => {
    const events = [
      ...variantBlock(0, "recursive_character", { source: false, parse: false, chunk: false }),
      ...variantBlock(1, "markdown_header", { source: true, parse: true, chunk: false }),
      ...variantBlock(2, "token_based", { source: true, parse: true, chunk: false }),
    ]
    const t = tallySweep(reduceEvents(events).variants)
    expect(t).toEqual({ executed: { source: 1, parse: 1, chunk: 3 }, cacheHits: 4, variants: 3 })
    expect(tallyLine(t, COLUMN)).toBe("Load ran 1 time, Parse ran 1 time, Chunk ran 3 times.")
  })

  it("names a node that never ran as coming from the cache", () => {
    const all = { source: true, parse: true, chunk: true }
    const events = [...variantBlock(0, "recursive_character", all), ...variantBlock(1, "token_based", all)]
    const t = tallySweep(reduceEvents(events).variants)
    expect(t).toEqual({ executed: { source: 0, parse: 0, chunk: 0 }, cacheHits: 6, variants: 2 })
    expect(tallyLine(t, COLUMN)).toBe("Nothing ran: every step came from the cache.")
    const some = { executed: { source: 0, parse: 0, chunk: 2 }, cacheHits: 4, variants: 2 }
    expect(tallyLine(some, COLUMN)).toBe("Chunk ran 2 times. Load and Parse came from the cache.")
  })

  it("an Index sweep through Search: one parse, five indexes, five searches", () => {
    const nodes = ["source", "parse", "chunk", "index", "query", "retrieve", "use_case"]
    const events: RunEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push({ event: "variant_started", ts: 0, index: i, variant: { transform: "lancedb", config: { truncate_dim: 1024 >> i } } })
      for (const id of nodes) {
        const fresh = i === 0 || ["index", "retrieve", "use_case"].includes(id)
        events.push({ event: "node_started", ts: 0, node_id: id, transform: id, artifact_id: `${id}-${i}` })
        events.push({ event: "node_finished", ts: 0, node_id: id, artifact_id: `${id}-${i}`, cache_hit: !fresh, duration_ms: 1 })
      }
    }
    const column = nodes.map((id) => ({ id, title: { source: "Load", parse: "Parse", chunk: "Chunk", index: "Index", query: "Ask", retrieve: "Retrieve", use_case: "Search" }[id]! }))
    expect(tallyLine(tallySweep(reduceEvents(events).variants), column)).toBe(
      "Load ran 1 time, Parse ran 1 time, Chunk ran 1 time, Index ran 5 times, Ask ran 1 time, Retrieve ran 5 times, Search ran 5 times.",
    )
  })

  it("tells two nodes with the same title apart by id", () => {
    const t = { executed: { clean_1: 1, clean_2: 0 }, cacheHits: 0, variants: 1 }
    expect(tallyLine(t, [{ id: "clean_1", title: "Clean" }, { id: "clean_2", title: "Clean" }])).toBe(
      "Clean clean_1 ran 1 time. Clean clean_2 came from the cache.",
    )
  })

  it("does not count a node that is still running", () => {
    const events = variantBlock(0, "recursive_character", { source: false, parse: false, chunk: false }).slice(0, 5)
    expect(tallySweep(reduceEvents(events).variants).executed.parse).toBeUndefined()
  })
})

describe("Matryoshka preset", () => {
  const index = { id: "index", stage: "index" as const, transform: "lancedb", config: { embedder: "qwen3-embedding-0.6b", truncate_dim: null } }

  it("asks for 1024, 512, 256, 128 and 64 on a 1024-wide model", () => {
    const vs = matryoshkaVariants(index, 1024)
    expect(vs.map((v) => v.config.truncate_dim)).toEqual([1024, 512, 256, 128, 64])
    expect(vs.every((v) => v.transform === "lancedb" && v.config.embedder === "qwen3-embedding-0.6b")).toBe(true)
  })

  it("starts at the native width of a narrower model and keeps only widths below it", () => {
    expect(matryoshkaVariants(index, 384).map((v) => v.config.truncate_dim)).toEqual([384, 256, 128, 64])
    // Unknown native width: the widest is the native width itself, whatever the model.
    expect(matryoshkaVariants(index).map((v) => v.config.truncate_dim)).toEqual([null, 512, 256, 128, 64])
    expect(baselineIndex(matryoshkaVariants(index), () => true)).toBe(0)
  })

  it("compares against the widest dimension that produced hits", () => {
    const vs = matryoshkaVariants(index, 1024)
    expect(baselineIndex(vs, () => true)).toBe(0)
    expect(baselineIndex(vs, (i) => i !== 0)).toBe(1)
    expect(baselineIndex([...vs, { transform: "lancedb", config: { truncate_dim: null } }], () => true)).toBe(5)
    expect(baselineIndex(vs, () => false)).toBeNull()
  })

  it("otherwise compares against the first variant, named by its transform", () => {
    const vs = [{ transform: "dense", config: {} }, { transform: "bm25", config: {} }]
    expect(baselineIndex(vs, () => true)).toBe(0)
    expect(variantName({ transform: "dense", fields: [] })).toBe("dense")
    expect(variantName({ transform: "lancedb", fields: [["truncate_dim", "1024"]] })).toBe("1024")
  })
})

describe("variantLabels", () => {
  it("names the transform and the config fields that vary between variants", () => {
    const labels = variantLabels(
      [
        { transform: "recursive_character", config: { chunk_size: 400, chunk_overlap: 0 } },
        { transform: "recursive_character", config: { chunk_size: 800, chunk_overlap: 0 } },
        { transform: "token_based", config: { max_tokens: 256, overlap: 32 } },
      ],
      R,
      "chunk",
    )
    expect(labels).toEqual([
      { transform: "recursive_character", fields: [["chunk_size", "400"]] },
      { transform: "recursive_character", fields: [["chunk_size", "800"]] },
      { transform: "token_based", fields: [] },
    ])
  })

  it("for a lone transform, lists fields that differ from its defaults", () => {
    const labels = variantLabels([{ transform: "token_based", config: { max_tokens: 128, overlap: 32 } }], R, "chunk")
    expect(labels).toEqual([{ transform: "token_based", fields: [["max_tokens", "128"]] }])
  })
})
