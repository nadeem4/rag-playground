import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { useOpenRecipes } from "./useOpenRecipes"

const renderOpen = ({ count, ready, fit = 3 }: { count: number; ready: number[]; fit?: number }) => renderHook(() => useOpenRecipes(count, ready, fit))

beforeEach(() => window.history.replaceState(null, "", "/compare?node=chunk"))
afterEach(() => window.history.replaceState(null, "", "/"))

describe("useOpenRecipes", () => {
  it("pushes one entry on open, replaces it on Next, and Back closes it", async () => {
    const { result } = renderOpen({ count: 7, ready: [0, 1, 2, 3, 4, 5, 6] })
    const before = window.history.length
    act(() => result.current.open([0, 3]))
    expect(new URLSearchParams(window.location.search).get("read")).toBe("1,4")
    expect(new URLSearchParams(window.location.search).get("node")).toBe("chunk")
    act(() => result.current.show([0, 5]))
    expect(window.history.length).toBe(before + 1)
    expect(result.current.ids).toEqual([0, 5])
    act(() => window.history.back())
    await waitFor(() => expect(result.current.ids).toBeNull())
  })

  it("drops a read the page has no results for", () => {
    window.history.replaceState(null, "", "/compare?node=chunk&read=2,5")
    renderOpen({ count: 7, ready: [] })
    expect(new URLSearchParams(window.location.search).get("read")).toBeNull()
    expect(new URLSearchParams(window.location.search).get("node")).toBe("chunk")
  })

  it("drops ids out of range or not finished, and cuts to what fits", () => {
    const { result } = renderOpen({ count: 5, ready: [0, 1, 2, 4], fit: 2 })
    act(() => result.current.open([0, 3, 9, 1, 2]))
    expect(result.current.ids).toEqual([0, 1])
  })

  it("closes by going back when the entry is its own, else by dropping read in place", async () => {
    const { result } = renderOpen({ count: 3, ready: [0, 1, 2] })
    act(() => result.current.open([1]))
    act(() => result.current.close())
    await waitFor(() => expect(result.current.ids).toBeNull())
    expect(new URLSearchParams(window.location.search).get("read")).toBeNull()
  })
})
