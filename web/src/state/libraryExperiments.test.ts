import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  EXPERIMENTS_KEY,
  MAX_EXPERIMENTS,
  OPEN_EXPERIMENT_KEY,
  clearExperiments,
  deleteExperiment,
  importExperiments,
  openExperiment,
  readExperiments,
  useExperiments,
  type SavedExperiment,
} from "./libraryExperiments"

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
      { ...exp("d", "2026-10-01T07:00:00Z"), doc: null, recipes: [{ transform: "x", config: {} }, { transform: 2 }, null] },
      null,
    ])
    const got = readExperiments()
    expect(got.map((e) => e.id)).toEqual(["a", "d"])
    expect(got[1].recipes).toEqual([{ transform: "x", config: {} }])
    expect(got[1].doc).toBeNull()
  })

  it("deletes one by id and clears all", () => {
    store([exp("a", "2026-10-01T10:00:00Z"), exp("b", "2026-10-01T09:00:00Z")])
    deleteExperiment("a")
    expect(readExperiments().map((e) => e.id)).toEqual(["b"])
    clearExperiments()
    expect(readExperiments()).toEqual([])
  })

  it("imports by id without duplicates, keeps the newest twenty and reports the dropped", () => {
    store([exp("a", "2026-10-01T10:00:00Z")])
    const older = Array.from({ length: MAX_EXPERIMENTS }, (_, i) => exp(`n${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`))
    const r = importExperiments([exp("a", "2026-10-02T00:00:00Z", { name: "renamed" }), ...older])!
    const kept = readExperiments()
    expect(kept).toHaveLength(MAX_EXPERIMENTS)
    expect(kept.filter((e) => e.id === "a")).toHaveLength(1)
    expect(kept[0].name).toBe("Experiment a")
    expect(r.skipped).toBe(1)
    expect(r.added).toBe(MAX_EXPERIMENTS - 1)
    expect(r.dropped.map((e) => e.id)).toEqual(["n0"])
  })

  it("marks an experiment to open on Compare in sessionStorage", () => {
    openExperiment("abc")
    expect(window.sessionStorage.getItem(OPEN_EXPERIMENT_KEY)).toBe("abc")
  })

  it("tells a subscriber about a change", () => {
    store([exp("a", "2026-10-01T10:00:00Z")])
    const { result } = renderHook(() => useExperiments())
    expect(result.current.map((e) => e.id)).toEqual(["a"])
    act(() => deleteExperiment("a"))
    expect(result.current).toEqual([])
  })
})
