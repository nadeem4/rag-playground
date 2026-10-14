import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FakeResizeObserver } from "./fakeResizeObserver"
import { useColumnsFit, useSideBySide } from "./useColumnsFit"

const box = () => ({ current: document.createElement("div") })

afterEach(() => {
  vi.unstubAllGlobals()
  FakeResizeObserver.reset()
})

describe("useColumnsFit", () => {
  it("returns true without ResizeObserver, as jsdom has none", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const { result } = renderHook(() => useColumnsFit(box(), 3))
    expect(result.current).toBe(true)
  })

  it("fits when every column gets 300 px and the pane is at least 820 px", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    FakeResizeObserver.width = 993
    const ref = box()
    const three = renderHook(() => useColumnsFit(ref, 3))
    expect(three.result.current).toBe(true)
    const four = renderHook(() => useColumnsFit(ref, 4))
    expect(four.result.current).toBe(false)
    FakeResizeObserver.width = 819
    const one = renderHook(() => useColumnsFit(box(), 1))
    expect(one.result.current).toBe(false)
  })

  it("measures before the first paint, so a narrow screen never draws every column", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    FakeResizeObserver.silent = true
    const el = document.createElement("div")
    Object.defineProperty(el, "clientWidth", { value: 753 })
    const { result } = renderHook(() => useColumnsFit({ current: el }, 3))
    expect(result.current).toBe(false)
  })

  it("follows a later resize", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    FakeResizeObserver.width = 1440
    const ref = box()
    const { result } = renderHook(() => useColumnsFit(ref, 3))
    expect(result.current).toBe(true)
    act(() => FakeResizeObserver.all[0].report(753))
    expect(result.current).toBe(false)
  })

  it("disconnects on unmount", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    const ref = box()
    const { unmount } = renderHook(() => useColumnsFit(ref, 3))
    unmount()
    expect(FakeResizeObserver.all[0].disconnected).toBe(true)
  })
})

describe("useSideBySide", () => {
  const renderSideBySide = () => renderHook(() => useSideBySide(box()))

  it("fits three side by side at 1024, two at 768 and one on a phone, and calls 768 narrow", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    for (const [w, fit, narrow] of [[993, 3, false], [1409, 3, false], [737, 2, true], [358, 1, true]] as const) {
      FakeResizeObserver.width = w
      const { result, unmount } = renderSideBySide()
      expect(result.current).toEqual({ fit, narrow })
      unmount()
    }
  })

  it("fits three and is not narrow without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    expect(renderSideBySide().result.current).toEqual({ fit: 3, narrow: false })
  })
})
