import { describe, expect, it } from "vitest"

import fixtureEvents from "./fixtures/run_events.json"
import { initialRunState, reduceEvents, runReducer } from "./runState"
import type { RunEvent } from "./types"

const ts = 1789956625
let seq = 0
const e = (event: Record<string, unknown>): RunEvent => ({ ts: ts + seq++, ...event }) as RunEvent

/** A two-variant sweep: the node ids repeat across variants. */
const sweepEvents: RunEvent[] = [
  e({ event: "variant_started", index: 0, variant: { transform: "recursive_character", config: {} } }),
  e({ event: "run_started", nodes: ["src", "parse", "chunk"], selected: ["chunk", "parse", "src"] }),
  e({ event: "node_started", node_id: "src", transform: "upload", artifact_id: "a1" }),
  e({ event: "node_finished", node_id: "src", artifact_id: "a1", cache_hit: false, duration_ms: 3.2 }),
  e({ event: "node_started", node_id: "parse", transform: "pdfium", artifact_id: "a2" }),
  e({ event: "node_finished", node_id: "parse", artifact_id: "a2", cache_hit: false, duration_ms: 67.5 }),
  e({ event: "node_started", node_id: "chunk", transform: "recursive_character", artifact_id: "a3" }),
  e({ event: "node_finished", node_id: "chunk", artifact_id: "a3", cache_hit: false, duration_ms: 4.1 }),
  e({ event: "run_finished", ok: true, cancelled: false }),
  e({ event: "variant_finished", index: 0, ok: true }),
  e({ event: "variant_started", index: 1, variant: { transform: "token_based", config: { max_tokens: 96 } } }),
  e({ event: "run_started", nodes: ["src", "parse", "chunk"], selected: ["chunk", "parse", "src"] }),
  e({ event: "node_started", node_id: "src", transform: "upload", artifact_id: "a1" }),
  e({ event: "node_finished", node_id: "src", artifact_id: "a1", cache_hit: true, duration_ms: 0.4 }),
  e({ event: "node_started", node_id: "parse", transform: "pdfium", artifact_id: "a2" }),
  e({ event: "node_finished", node_id: "parse", artifact_id: "a2", cache_hit: true, duration_ms: 0.6 }),
  e({ event: "node_started", node_id: "chunk", transform: "token_based", artifact_id: "a4" }),
  e({ event: "node_failed", node_id: "chunk", error: "Traceback (most recent call last):\n  ValueError: boom" }),
  e({ event: "run_finished", ok: false, cancelled: false }),
  e({ event: "variant_finished", index: 1, ok: false }),
  e({ event: "stream_end", status: "finished", ok: false, extra_field_from_a_newer_server: 1 }),
]

describe("runReducer: sweeps", () => {
  it("does not close after the first run_finished", () => {
    const firstRunFinished = sweepEvents.findIndex((x) => x.event === "run_finished")
    const state = reduceEvents(sweepEvents.slice(0, firstRunFinished + 1))
    expect(state.closed).toBe(false)
    expect(state.status).toBe("running")
  })

  it("keeps both variants' node states, even though node ids repeat", () => {
    const state = reduceEvents(sweepEvents)
    expect(state.variants).toHaveLength(2)
    const [v0, v1] = state.variants
    expect(v0.index).toBe(0)
    expect(v0.nodes.chunk).toMatchObject({ status: "done", artifact_id: "a3", cache_hit: false })
    expect(v0.ok).toBe(true)
    expect(v1.index).toBe(1)
    expect(v1.variant?.transform).toBe("token_based")
    expect(v1.nodes.src).toMatchObject({ status: "cached", cache_hit: true })
    expect(v1.nodes.chunk.status).toBe("failed")
    expect(v1.nodes.chunk.error).toContain("ValueError: boom")
    expect(v1.ok).toBe(false)
  })

  it("closes on stream_end and takes its status", () => {
    const state = reduceEvents(sweepEvents)
    expect(state.closed).toBe(true)
    expect(state.status).toBe("finished")
    expect(state.ok).toBe(false)
  })
})

describe("runReducer: a plain run", () => {
  it("reduces the real executor stream exported from the engine", () => {
    const events = [
      ...(fixtureEvents as RunEvent[]),
      e({ event: "stream_end", status: "finished", ok: true }),
    ]
    const state = reduceEvents(events)
    expect(state.variants).toHaveLength(1)
    const nodes = state.variants[0].nodes
    expect(Object.keys(nodes)).toEqual(state.variants[0].order)
    for (const node of Object.values(nodes)) {
      expect(node.status).toBe("done")
      expect(node.artifact_id).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof node.duration_ms).toBe("number")
    }
    expect(state.closed).toBe(true)
  })

  it("marks the order as pending before any node starts", () => {
    const state = reduceEvents([e({ event: "run_started", nodes: ["a", "b"], selected: ["a"] })])
    expect(state.variants[0].nodes.a.status).toBe("pending")
    expect(state.variants[0].nodes.b.status).toBe("pruned")
  })

  it("records skips, cancellation, warnings and a crashed run", () => {
    const state = reduceEvents([
      e({ event: "run_started", nodes: ["a", "b", "c"], selected: ["a", "b", "c"] }),
      e({ event: "warning", message: "override for node 'z' ignored" }),
      e({ event: "node_skipped", node_id: "b" }),
      e({ event: "run_cancelled", skipped: ["c"] }),
      e({ event: "run_error", error: "Traceback: worker died" }),
      e({ event: "stream_end", status: "error", ok: false }),
    ])
    const nodes = state.variants[0].nodes
    expect(nodes.b.status).toBe("skipped")
    expect(nodes.c.status).toBe("skipped")
    expect(state.warnings).toEqual(["override for node 'z' ignored"])
    expect(state.error).toBe("Traceback: worker died")
    expect(state.status).toBe("error")
  })

  it("ignores unknown events instead of throwing", () => {
    const state = runReducer(initialRunState, {
      type: "event",
      event: { event: "something_new", ts } as unknown as RunEvent,
    })
    expect(state).toEqual(initialRunState)
  })
})
