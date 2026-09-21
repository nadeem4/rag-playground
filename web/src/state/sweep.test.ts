import { describe, expect, it } from "vitest"

import { reduceEvents } from "@/api/runState"
import type { RunEvent } from "@/api/types"

import { tallyLine, tallySweep, variantLabels } from "./sweep"
import { TEST_REGISTRY as R } from "./testRegistry"

const NODES = ["source", "parse", "chunk"]
const STAGES = { source: "source", parse: "parse", chunk: "chunk" } as const

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

describe("tallySweep", () => {
  it("counts parse executions from node_finished cache_hit:false, not variants", () => {
    const events = [
      ...variantBlock(0, "recursive_character", { source: false, parse: false, chunk: false }),
      ...variantBlock(1, "markdown_header", { source: true, parse: true, chunk: false }),
      ...variantBlock(2, "token_based", { source: true, parse: true, chunk: false }),
    ]
    const t = tallySweep(reduceEvents(events).variants, STAGES, "chunk")
    expect(t).toEqual({ parsed: 1, swept: 3, cacheHits: 4, variants: 3 })
    expect(tallyLine(t, "chunk")).toBe("parsed 1 time, chunked 3 times, 4 cache hits")
  })

  it("reports zero executions when every variant hits the cache", () => {
    const all = { source: true, parse: true, chunk: true }
    const events = [...variantBlock(0, "recursive_character", all), ...variantBlock(1, "token_based", all)]
    const t = tallySweep(reduceEvents(events).variants, STAGES, "chunk")
    expect(t).toEqual({ parsed: 0, swept: 0, cacheHits: 6, variants: 2 })
    expect(tallyLine(t, "chunk")).toBe("parsed 0 times, chunked 0 times, 6 cache hits")
  })

  it("does not count a node that is still running", () => {
    const events = variantBlock(0, "recursive_character", { source: false, parse: false, chunk: false }).slice(0, 5)
    expect(tallySweep(reduceEvents(events).variants, STAGES, "chunk").parsed).toBe(0)
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
