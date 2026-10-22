import { StrictMode, type ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RunEvent, RunSnapshot } from "./types"
import { useRun } from "./useRun"

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.OPEN
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onopen: ((ev: Event) => void) | null = null
  close = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED
  })

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  emit(seq: number, event: Record<string, unknown>) {
    act(() => {
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: 1789956625 + seq, ...event }),
          lastEventId: String(seq),
        }),
      )
    })
  }

  fail() {
    act(() => {
      this.readyState = FakeEventSource.CLOSED
      this.onerror?.(new Event("error"))
    })
  }
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
const live = () => FakeEventSource.instances.filter((es) => es.readyState !== FakeEventSource.CLOSED)

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
})

afterEach(() => {
  // Unmount every hook, so no run of one test is still reading in the next.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useRun", () => {
  it("opens exactly one EventSource under StrictMode double-mount", async () => {
    renderHook(() => useRun("r1"), { wrapper: strict })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe("/api/v2/runs/r1/events")
    expect(live()).toHaveLength(1)
  })

  it("keeps a comparison stream open past run_finished and closes it on stream_end", () => {
    const { result } = renderHook(() => useRun("s1"), { wrapper: strict })
    const es = FakeEventSource.instances[0]

    es.emit(1, { variant: 1, event: "run_started", nodes: ["chunk"], selected: ["chunk"] })
    es.emit(2, { variant: 1, event: "node_finished", node_id: "chunk", artifact_id: "a1", cache_hit: false, duration_ms: 2 })
    es.emit(3, { variant: 1, event: "run_finished", ok: true, cancelled: false })
    expect(es.close).not.toHaveBeenCalled()
    expect(result.current.status).toBe("running")

    es.emit(5, { variant: 2, event: "run_started", nodes: ["chunk"], selected: ["chunk"] })
    es.emit(6, { variant: 2, event: "node_finished", node_id: "chunk", artifact_id: "a2", cache_hit: true, duration_ms: 1 })
    es.emit(7, { variant: 2, event: "run_finished", ok: true, cancelled: false })
    expect(es.close).not.toHaveBeenCalled()

    es.emit(8, { event: "stream_end", status: "finished", ok: true })
    expect(es.close).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe("finished")
    expect(result.current.variants.map((v) => v.nodes.chunk.artifact_id)).toEqual(["a1", "a2"])
    // `nodes` is the latest variant's.
    expect(result.current.nodes.chunk.status).toBe("cached")
  })

  it("tolerates extra fields and junk frames", () => {
    const { result } = renderHook(() => useRun("r2"))
    const es = FakeEventSource.instances[0]
    es.emit(0, { event: "run_started", nodes: ["a"], selected: ["a"], brand_new: { x: 1 } })
    act(() => {
      es.onmessage?.(new MessageEvent("message", { data: "not json", lastEventId: "1" }))
    })
    expect(result.current.nodes.a.status).toBe("pending")
  })

  it("on a dropped connection, resyncs from the snapshot and ignores replayed events", async () => {
    const events: RunEvent[] = [
      { event: "run_started", ts: 1, nodes: ["a", "b"], selected: ["a", "b"] },
      { event: "node_started", ts: 2, node_id: "a", transform: "pdfium", artifact_id: "x" },
      { event: "node_finished", ts: 3, node_id: "a", artifact_id: "x", cache_hit: false, duration_ms: 5 },
    ]
    const snapshot: RunSnapshot = {
      run_id: "r3",
      kind: "run",
      status: "running",
      ok: null,
      cancel_requested: false,
      last_event_id: 2,
      events,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useRun("r3"))
    const first = FakeEventSource.instances[0]
    first.emit(0, events[0])
    first.fail()

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/runs/r3", undefined)
    expect(result.current.nodes.a.status).toBe("done")

    const second = FakeEventSource.instances[1]
    // The reopened stream resumes after the snapshot's last event.
    expect(second.url).toBe("/api/v2/runs/r3/events?last_event_id=2")
    // Should a server replay anyway, already-applied ids are still skipped.
    second.emit(0, events[0])
    expect(result.current.nodes.a.status).toBe("done")
    second.emit(3, { event: "node_finished", node_id: "b", artifact_id: "y", cache_hit: true, duration_ms: 1 })
    second.emit(4, { event: "stream_end", status: "finished", ok: true })
    expect(result.current.nodes.b.status).toBe("cached")
    expect(second.close).toHaveBeenCalled()
  })

  it("reads the run's result from its snapshot once the stream ends", async () => {
    const snapshot: RunSnapshot = {
      run_id: "r5",
      kind: "evaluation",
      status: "finished",
      ok: true,
      cancel_requested: false,
      last_event_id: 1,
      events: [],
      result: { hit_rate: 0.5 },
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useRun("r5"))
    const es = FakeEventSource.instances[0]
    es.emit(0, { event: "run_started", nodes: ["a"], selected: ["a"] })
    expect(fetchMock).not.toHaveBeenCalled()
    es.emit(1, { event: "stream_end", status: "finished", ok: true })

    await waitFor(() => expect(result.current.result).toEqual({ hit_rate: 0.5 }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/runs/r5", undefined)
  })

  it("tries the result read once more when it fails", async () => {
    const snapshot: RunSnapshot = {
      run_id: "r6",
      kind: "evaluation",
      status: "finished",
      ok: true,
      cancel_requested: false,
      last_event_id: 0,
      events: [],
      result: { hit_rate: 1 },
    }
    let calls = 0
    const fetchMock = vi.fn(async () => (++calls === 1 ? new Response("down", { status: 500 }) : new Response(JSON.stringify(snapshot), { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useRun("r6"))
    FakeEventSource.instances[0].emit(0, { event: "stream_end", status: "finished", ok: true })

    await waitFor(() => expect(result.current.result).toEqual({ hit_rate: 1 }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.resultFailed).toBe(false)
  })

  it("says the result could not be read when the second read fails too, and reads no more", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useRun("r7"))
    expect(result.current.resultFailed).toBe(false)
    FakeEventSource.instances[0].emit(0, { event: "stream_end", status: "finished", ok: true })

    await waitFor(() => expect(result.current.resultFailed).toBe(true))
    expect(result.current.result).toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("closes the stream on unmount", async () => {
    const { unmount } = renderHook(() => useRun("r4"))
    unmount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(FakeEventSource.instances[0].close).toHaveBeenCalled()
  })

  it("stays idle with no run id", () => {
    const { result } = renderHook(() => useRun(null))
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(result.current.status).toBe("idle")
    expect(result.current.nodes).toEqual({})
  })
})

describe("a new run id", () => {
  it("never hands out the last run's state, not even on the render where the id changes", () => {
    const seen: { id: string; closed: boolean; nodes: string[] }[] = []
    const { rerender } = renderHook(({ id }) => {
      const run = useRun(id)
      seen.push({ id, closed: run.closed, nodes: Object.keys(run.nodes) })
      return run
    }, { initialProps: { id: "old" } })
    const es = FakeEventSource.instances[0]
    es.emit(0, { event: "run_started", nodes: ["a"], selected: ["a"] })
    es.emit(1, { event: "stream_end", status: "finished", ok: true })
    expect(seen[seen.length - 1]).toMatchObject({ id: "old", closed: true, nodes: ["a"] })
    seen.length = 0
    rerender({ id: "new" })
    // Every render of the new run, the first included, starts fresh.
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s).toEqual({ id: "new", closed: false, nodes: [] })
  })
})
