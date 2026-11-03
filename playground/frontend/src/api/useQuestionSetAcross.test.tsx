import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useQuestionSet } from "./useQuestionSet"
import { useQuestionSetAcross } from "./useQuestionSetAcross"

const SAMPLES: never[] = []
afterEach(() => vi.unstubAllGlobals())

describe("with no document to ask about", () => {
  it("useQuestionSetAcross is loaded with no questions, not loading for ever", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }))
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => useQuestionSetAcross([], SAMPLES))
    await waitFor(() => expect(result.current.questions).toEqual([]))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("useQuestionSet asks nothing and has no set", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }))
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => useQuestionSet(""))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.set).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
