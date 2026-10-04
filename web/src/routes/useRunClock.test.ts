import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { VariantState } from "@/api/runState"

import { useRunClock } from "./useRunClock"

afterEach(() => vi.useRealTimers())

const started = (...idx: number[]): VariantState[] => idx.map((index) => ({ index, order: [], nodes: {} }))

describe("useRunClock", () => {
  it("counts each recipe's seconds from when the browser first saw it start, never from the server's time", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    const { result, rerender } = renderHook(({ v, on }) => useRunClock(v, on), { initialProps: { v: started(0), on: true } })
    expect(result.current(0)).toBe(0)
    expect(result.current(1)).toBeNull()
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current(0)).toBe(2)
    rerender({ v: started(0, 1), on: true })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current(0)).toBe(3)
    expect(result.current(1)).toBe(1)
  })

  it("stops ticking when nothing runs", () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, "setInterval")
    renderHook(() => useRunClock(started(0), false))
    expect(spy).not.toHaveBeenCalled()
  })
})
