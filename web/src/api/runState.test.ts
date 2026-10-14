import { describe, expect, it } from "vitest"

import fixtureEvents from "./fixtures/run_events.json"
import { cardEvent, initialRunState, reduceEvents, runReducer } from "./runState"
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

describe("runReducer: node timing", () => {
  it("records when a node started, from the event's ts in epoch seconds", () => {
    const state = reduceEvents([
      { ts: 100, event: "run_started", nodes: ["parse"], selected: ["parse"] } as RunEvent,
      { ts: 123.5, event: "node_started", node_id: "parse", transform: "docling", artifact_id: "a" } as RunEvent,
    ])
    expect(state.variants[0].nodes.parse).toMatchObject({ status: "running", started_at: 123.5 })
  })
})

describe("runReducer: waiting for a turn on the demo", () => {
  it("is queued from queued until unqueued, and never after the stream ends", () => {
    expect(initialRunState.queued).toBe(false)
    expect(reduceEvents([e({ event: "queued", ahead: 0 })]).queued).toBe(true)
    expect(reduceEvents([e({ event: "queued", ahead: 0 }), e({ event: "unqueued" })]).queued).toBe(false)
    // Cancelled while waiting: the stream ends with no unqueued.
    expect(reduceEvents([e({ event: "queued", ahead: 0 }), e({ event: "stream_end", status: "cancelled", ok: false })]).queued).toBe(false)
  })
})

describe("/api/v2 events", () => {
  const ts = 1
  it("names each step by its card", () => {
    const s = reduceEvents([
      {
        event: "run_started", ts, nodes: ["doc::parse", "doc::clean.1"], selected: ["doc::parse", "doc::clean.1"],
        steps: [{ document: "doc", step: "parse" }, { document: "doc", step: "clean.1" }],
        selected_steps: [{ document: "doc", step: "parse" }, { document: "doc", step: "clean.1" }],
      },
      { event: "node_finished", ts, node_id: "doc::clean.1", document: "doc", step: "clean.1", artifact_id: "x", cache_hit: false, duration_ms: 3 },
    ] as never)
    expect(s.variants[0].order).toEqual(["parse", "clean_1"])
    expect(s.variants[0].nodes.clean_1).toMatchObject({ status: "done", artifact_id: "x" })
  })

  it("names each card once when a run covers several documents", () => {
    const two = (step: string) => [{ document: "doc1", step }, { document: "doc2", step }]
    const e = cardEvent({
      event: "run_started", ts, nodes: ["doc1::parse", "doc2::parse", "doc1::chunk", "doc2::chunk"], selected: [],
      steps: [...two("parse"), ...two("chunk")],
      selected_steps: [...two("parse"), ...two("chunk")],
      skipped_steps: two("chunk"),
    } as never) as unknown as { nodes: string[]; selected: string[] }
    expect(e.nodes).toEqual(["parse", "chunk"])
    expect(e.selected).toEqual(["parse", "chunk"])
    const cancelled = cardEvent({ event: "run_cancelled", ts, skipped: [], skipped_steps: two("index") } as never) as unknown as { skipped: string[] }
    expect(cancelled.skipped).toEqual(["index"])
    const s = reduceEvents([{ event: "run_started", ts, nodes: [], selected: [], steps: [...two("parse"), ...two("chunk")] }] as never)
    expect(s.variants[0].order).toEqual(["parse", "chunk"])
  })

  it("merges the search's run_started into the index's, as Pandion's ask runs both", () => {
    const s = reduceEvents([
      { event: "run_started", ts, nodes: ["d::chunk"], selected: ["d::chunk"], steps: [{ document: "d", step: "chunk" }] },
      { event: "run_finished", ts, ok: true },
      { event: "run_started", ts, nodes: ["search"], selected: ["search"], steps: [{ document: null, step: "search" }] },
      { event: "node_finished", ts, node_id: "search", step: "search", document: null, artifact_id: "h", cache_hit: true, duration_ms: 1 },
    ] as never)
    expect(s.variants).toHaveLength(1)
    expect(Object.keys(s.variants[0].nodes).sort()).toEqual(["chunk", "retrieve"])
  })

  it("groups a comparison's events by variant and an evaluation's by question", () => {
    const cmp = reduceEvents([
      { event: "node_finished", ts, node_id: "d::chunk", step: "chunk", document: "d", artifact_id: "a", cache_hit: false, duration_ms: 1, variant: 1, variants: 2 },
      { event: "node_finished", ts, node_id: "d::chunk", step: "chunk", document: "d", artifact_id: "b", cache_hit: false, duration_ms: 1, variant: 2, variants: 2 },
    ] as never)
    expect(cmp.variants.map((v) => [v.index, v.nodes.chunk.artifact_id])).toEqual([[0, "a"], [1, "b"]])
    const ev = reduceEvents([
      { event: "node_finished", ts, node_id: "search", step: "search", document: null, artifact_id: "s1", cache_hit: false, duration_ms: 1, question: "q1" },
      { event: "question_finished", ts, question: "q1", number: 1, total: 2, found: true, error: null },
      { event: "question_finished", ts, question: "q2", number: 2, total: 2, found: false, error: null },
    ] as never)
    expect(ev.variants[0].question).toBe("q1")
    expect(ev.questions).toEqual({ q1: { found: true, error: null, number: 1 }, q2: { found: false, error: null, number: 2 } })
  })

  it("leaves an old route's event as it is", () => {
    const e = { event: "node_finished", ts, node_id: "chunk", artifact_id: "a", cache_hit: false, duration_ms: 1 }
    expect(cardEvent(e as never)).toBe(e)
  })
})
