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

  it("a problem Pandion words about one setting goes under that setting, with a short warning", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 0 })]))
    act(() => vi.advanceTimersByTime(0))
    const problems = ["chunk (recursive_character): chunk_size: Input should be greater than or equal to 1."]
    calls[0].resolve(new Response(JSON.stringify({ detail: { problems } }), { status: 422 }))
    await flush()
    expect(result.current.chunk.data).toEqual({ settings: "", tradeoff: null, warning: "Fix the setting marked below.", blocking: true })
    expect(result.current.chunk.fields).toEqual({ chunk_size: ["Input should be greater than or equal to 1."] })
  })

  it("a stale setting an old pipeline still carries is named in the card's warning", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 400, old_key: 1 })]))
    act(() => vi.advanceTimersByTime(0))
    const problems = ["chunk (recursive_character) has no setting 'old_key'. Its settings are: chunk_size, chunk_overlap, heading_context."]
    calls[0].resolve(new Response(JSON.stringify({ detail: { problems } }), { status: 422 }))
    await flush()
    expect(result.current.chunk.data).toEqual({ settings: "", tradeoff: null, warning: problems[0], blocking: true })
    expect(result.current.chunk.fields).toBeUndefined()
  })

  it("a problem about another strategy keeps the whole sentence and marks no setting", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 0 })]))
    act(() => vi.advanceTimersByTime(0))
    const problems = ["chunk (token_based): max_tokens: Too small."]
    calls[0].resolve(new Response(JSON.stringify({ detail: { problems } }), { status: 422 }))
    await flush()
    expect(result.current.chunk.data?.warning).toBe(problems[0])
    expect(result.current.chunk.fields).toBeUndefined()
  })

  it("a 422 of any other shape still warns and blocks Run", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 400 })]))
    act(() => vi.advanceTimersByTime(0))
    const detail = [{ loc: ["body", "settings"], msg: "Input should be a valid dictionary", type: "dict_type" }]
    calls[0].resolve(new Response(JSON.stringify({ detail }), { status: 422 }))
    await flush()
    expect(result.current.chunk.data).toEqual({
      settings: "",
      tradeoff: null,
      warning: "This server refused these settings. settings: Input should be a valid dictionary.",
      blocking: true,
    })
  })

  it("a 404 says in plain words that this server does not have the strategy", async () => {
    const { result } = renderHook(() => useExplanations([chunk({ chunk_size: 400 })]))
    act(() => vi.advanceTimersByTime(0))
    calls[0].resolve(new Response(JSON.stringify({ detail: "x" }), { status: 404 }))
    await flush()
    expect(result.current.chunk.data).toEqual({
      settings: "",
      tradeoff: null,
      warning: "This server does not have recursive_character. Pick another.",
      blocking: true,
    })
  })

  it("a server error or a dropped connection keeps what is shown", async () => {
    const { result, rerender } = renderHook(({ nodes }) => useExplanations(nodes), { initialProps: { nodes: [chunk({ chunk_size: 400 })] } })
    act(() => vi.advanceTimersByTime(0))
    calls[0].resolve(reply("Pieces of 400"))
    await flush()
    rerender({ nodes: [chunk({ chunk_size: 500 })] })
    act(() => vi.advanceTimersByTime(EXPLAIN_DEBOUNCE_MS))
    calls[1].resolve(new Response("boom", { status: 500 }))
    await flush()
    expect(result.current.chunk.data?.settings).toBe("Pieces of 400")
  })
})
