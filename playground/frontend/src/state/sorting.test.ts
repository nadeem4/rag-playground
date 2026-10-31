import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { v2 } from "@/api/v2"
import type { PipelineConfig } from "@/state/config"

import { lineOf, pinSorted, useSorting } from "./sorting"

const step = { use: "x" }
const cat = (name: string) => ({ name, parse: step, chunk: step })
const config = (route: PipelineConfig["route"]): PipelineConfig => ({
  index: { store: step },
  categories: { default: cat("Default"), reports: cat("Reports with tables") },
  route,
})
const ROUTES = [{ when: step, category: "reports" }, { category: "default" }]

beforeEach(() => vi.restoreAllMocks())

describe("lineOf", () => {
  it("turns a rule reason into the by rule 2 sentence", () => {
    expect(lineOf("Reports with tables", "Rule 2: path matches legal/**")).toBe("Reports with tables, by rule 2")
  })
  it("says chosen by hand for a pin and by default for the last rule", () => {
    expect(lineOf("Default", "Chosen when added")).toBe("Default, chosen by hand")
    expect(lineOf("Default", "Default: no rule matched")).toBe("Default, by default")
  })
})

describe("useSorting", () => {
  it("asks only for documents with no pin, and a pinned one shows Chosen when added", async () => {
    const sort = vi.spyOn(v2, "sortDocuments").mockResolvedValue({ documents: { b: { category: "reports", reason: "Rule 1: x" } } })
    const docs = [{ sha: "a", filename: "a.pdf", category: "default" }, { sha: "b", filename: "b.pdf" }]
    const { result } = renderHook(() => useSorting(config(ROUTES), docs))
    await waitFor(() => expect(result.current.b).toBeTruthy())
    expect(sort.mock.calls[0][1]).toEqual(["b"])
    expect(result.current.a).toEqual({ category: "default", reason: "Chosen when added" })
  })

  it("a pinned document keeps its category when the routes change", async () => {
    vi.spyOn(v2, "sortDocuments").mockResolvedValue({ documents: {} })
    const docs = [{ sha: "a", filename: "a.pdf", category: "default" }]
    const { result, rerender } = renderHook(({ c }) => useSorting(c, docs), { initialProps: { c: config(ROUTES) } })
    rerender({ c: config([{ category: "reports" }]) })
    expect(result.current.a.category).toBe("default")
  })

  it("sorts nothing for a config with one default category", () => {
    const sort = vi.spyOn(v2, "sortDocuments")
    const { result } = renderHook(() => useSorting({ index: { store: step, parse: step, chunk: step } }, [{ sha: "a", filename: "a.pdf" }]))
    expect(result.current).toEqual({})
    expect(sort).not.toHaveBeenCalled()
  })
})

describe("pinSorted", () => {
  it("pins an unpinned document to its sorted category and leaves pins alone", () => {
    const docs = [{ sha: "a", filename: "a.pdf", category: "default" }, { sha: "b", filename: "b.pdf" }]
    const sorted = { a: { category: "reports", reason: "x" }, b: { category: "reports", reason: "Rule 1: x" } }
    expect(pinSorted(docs, sorted)).toEqual([{ sha: "a", filename: "a.pdf", category: "default" }, { sha: "b", filename: "b.pdf", category: "reports" }])
  })
  it("returns the same list when nothing needs a pin", () => {
    const docs = [{ sha: "a", filename: "a.pdf", category: "default" }]
    expect(pinSorted(docs, {})).toBe(docs)
  })
})
