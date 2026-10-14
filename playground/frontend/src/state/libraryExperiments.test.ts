import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  EXPERIMENTS_KEY,
  MAX_EXPERIMENTS,
  MAX_RECIPES,
  OPEN_EXPERIMENT_KEY,
  clearExperiments,
  deleteExperiment,
  importExperiments,
  openExperiment,
  readExperiments,
  useExperiments,
  type SavedExperiment,
} from "./libraryExperiments"
import { readExperiments as compareList, resetExperimentsForTests, takeOpenRequest } from "./experiments"

const exp = (id: string, savedAt: string, extra: Partial<SavedExperiment> = {}): SavedExperiment => ({
  id,
  name: `Experiment ${id}`,
  stage: "chunk",
  recipes: [{ transform: "recursive_character", config: { chunk_size: 400 } }],
  doc: { sha: "ab".repeat(32), filename: "report.pdf" },
  savedAt,
  ...extra,
})

const store = (v: unknown) => window.localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(v))

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetExperimentsForTests()
})

describe("the experiments adapter", () => {
  it("reads nothing when the store is absent or is not JSON", () => {
    expect(readExperiments()).toEqual([])
    window.localStorage.setItem(EXPERIMENTS_KEY, "not json")
    expect(readExperiments()).toEqual([])
    store({ not: "a list" })
    expect(readExperiments()).toEqual([])
  })

  it("guards every field and drops what does not fit", () => {
    store([
      exp("a", "2026-10-01T10:00:00Z"),
      { id: 3, name: "bad id" },
      { ...exp("b", "2026-10-01T09:00:00Z"), recipes: "nope" },
      { ...exp("c", "2026-10-01T08:00:00Z"), doc: { sha: 1 } },
      { ...exp("d", "2026-10-01T07:00:00Z"), doc: null, recipes: [{ transform: "x", config: {} }] },
      { ...exp("e", "2026-10-01T06:00:00Z"), recipes: [{ transform: "x", config: {} }, { transform: 2 }, null] },
      null,
    ])
    const got = readExperiments()
    expect(got.map((e) => e.id)).toEqual(["a", "d"])
    expect(got[1].doc).toBeNull()
  })

  it("deletes one by id and clears all", () => {
    store([exp("a", "2026-10-01T10:00:00Z"), exp("b", "2026-10-01T09:00:00Z")])
    deleteExperiment("a")
    expect(readExperiments().map((e) => e.id)).toEqual(["b"])
    clearExperiments()
    expect(readExperiments()).toEqual([])
  })

  it("imports by id without duplicates, and never removes an experiment already saved", () => {
    const mine = Array.from({ length: 4 }, (_, i) => exp(`m${i}`, `2026-01-0${i + 1}T00:00:00Z`))
    store(mine)
    const incoming = [exp("m0", "2026-10-02T00:00:00Z", { name: "renamed" }), ...Array.from({ length: 25 }, (_, i) => exp(`n${String(i).padStart(2, "0")}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`))]
    const r = importExperiments(incoming)!
    const kept = readExperiments()
    expect(kept).toHaveLength(MAX_EXPERIMENTS)
    for (const m of mine) expect(kept.map((e) => e.id)).toContain(m.id)
    expect(kept.find((e) => e.id === "m0")!.name).toBe("Experiment m0")
    expect(r.skipped).toBe(1)
    expect(r.added).toBe(16)
    expect(r.leftOut.map((e) => e.id)).toEqual(["n08", "n07", "n06", "n05", "n04", "n03", "n02", "n01", "n00"])
  })

  it("keeps Compare's raw entries: fields it does not know, and entries it cannot read, survive a delete and an import", () => {
    const rich = { ...exp("a", "2026-10-01T10:00:00Z"), question: "Who?", recipes: [{ transform: "t", config: {}, label: "Small", phrase: "small pieces" }] }
    const odd = { id: "z", something: "Compare added later" }
    store([rich, odd, exp("b", "2026-10-01T09:00:00Z")])
    deleteExperiment("b")
    expect(JSON.parse(window.localStorage.getItem(EXPERIMENTS_KEY)!)).toEqual([rich, odd])
    importExperiments([{ ...exp("c", "2026-10-02T00:00:00Z"), extra: 1 } as SavedExperiment])
    const raw = JSON.parse(window.localStorage.getItem(EXPERIMENTS_KEY)!)
    expect(raw).toContainEqual(rich)
    expect(raw).toContainEqual(odd)
    expect(raw).toContainEqual({ ...exp("c", "2026-10-02T00:00:00Z"), extra: 1 })
  })

  it("refuses an incoming experiment with more than ten recipes", () => {
    const many = exp("big", "2026-10-02T00:00:00Z", { recipes: Array.from({ length: MAX_RECIPES + 1 }, () => ({ transform: "t", config: {} })) })
    const r = importExperiments([many, exp("ok", "2026-10-02T00:00:00Z")])!
    expect(r.added).toBe(1)
    expect(r.invalid).toBe(1)
    expect(readExperiments().map((e) => e.id)).toEqual(["ok"])
  })

  it("marks an experiment to open through Compare's own handoff", () => {
    openExperiment("abc")
    expect(window.sessionStorage.getItem(OPEN_EXPERIMENT_KEY)).toBe("abc")
    expect(takeOpenRequest()).toBe("abc")
  })

  it("shares Compare's store, so a Library delete or import shows in Compare's list at once", () => {
    store([exp("a", "2026-10-01T10:00:00Z"), exp("b", "2026-10-01T09:00:00Z")])
    expect(compareList().map((e) => e.id)).toEqual(["a", "b"])
    deleteExperiment("a")
    expect(compareList().map((e) => e.id)).toEqual(["b"])
    importExperiments([exp("c", "2026-10-02T00:00:00Z")])
    expect(compareList().map((e) => e.id).sort()).toEqual(["b", "c"])
  })

  it("tells a subscriber about a change", () => {
    store([exp("a", "2026-10-01T10:00:00Z")])
    const { result } = renderHook(() => useExperiments())
    expect(result.current.map((e) => e.id)).toEqual(["a"])
    act(() => deleteExperiment("a"))
    expect(result.current).toEqual([])
  })
})
