import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { GraphNode } from "./types"
import { EXPLAIN_DEBOUNCE_MS, useExplanations } from "./useExplain"

interface Call {
  url: string
  body: { stage: string; use: string; settings: Record<string, unknown> }
  signal?: AbortSignal
  resolve: (r: Response) => void
}
let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.useFakeTimers()
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => calls.push({ url, body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined, resolve })),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const chunk = (config: Record<string, unknown>): GraphNode => ({ id: "chunk", stage: "chunk", transform: "recursive_character", config })
const reply = (settings: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ settings, tradeoff: null, warning: null, blocking: false, ...extra }), { status: 200 })

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("useExplanations", () => {
  it("asks at once on mount, then debounces changes and sends only the settled config", async () => {
    const { result, rerender } = renderHook(({ nodes }) => useExplanations(nodes), { initialProps: { nodes: [chunk({ chunk_size: 1000 })] } })
    act(() => vi.advanceTimersByTime(0))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("/api/v2/explain")
    expect(calls[0].body).toEqual({ stage: "chunk", use: "recursive_character", settings: { chunk_size: 1000 } })
    calls[0].resolve(reply("Pieces of 1000"))
    await flush()
    expect(result.current.chunk.data?.settings).toBe("Pieces of 1000")

    rerender({ nodes: [chunk({ chunk_size: 10 })] })
    rerender({ nodes: [chunk({ chunk_size: 100 })] })
    rerender({ nodes: [chunk({ chunk_size: 1200 })] })
    act(() => vi.advanceTimersByTime(EXPLAIN_DEBOUNCE_MS - 1))
    expect(calls).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(calls).toHaveLength(2)
    expect(calls[1].body.settings).toEqual({ chunk_size: 1200 })
    // The old text stays up while the new one loads: no empty flash.
    expect(result.current.chunk.data?.settings).toBe("Pieces of 1000")
  })

  it("aborts an in-flight request when the config changes, and ignores its late answer", async () => {
    const { result, rerender } = renderHook(({ nodes }) => useExplanations(nodes), { initialProps: { nodes: [chunk({ chunk_size: 1000 })] } })
    act(() => vi.advanceTimersByTime(0))
    rerender({ nodes: [chunk({ chunk_size: 500 })] })
    expect(calls[0].signal?.aborted).toBe(true)
    act(() => vi.advanceTimersByTime(EXPLAIN_DEBOUNCE_MS))
    calls[1].resolve(reply("Pieces of 500"))
    await flush()
    calls[0].resolve(reply("Pieces of 1000"))
    await flush()
    expect(result.current.chunk.data?.settings).toBe("Pieces of 500")
  })

  it("a 422's problems become the card's blocking warning, in Pandion's words", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 0 })]))
    act(() => vi.advanceTimersByTime(0))
    const problems = ["chunk_size must be at least 1.", "Change it on the chunk step."]
    calls[0].resolve(new Response(JSON.stringify({ detail: { problems } }), { status: 422 }))
    await flush()
    expect(result.current.chunk.data).toEqual({ settings: "", tradeoff: null, warning: problems.join(" "), blocking: true })
  })
})
