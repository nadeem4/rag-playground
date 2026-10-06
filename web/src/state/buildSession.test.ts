import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BUILD_SESSION_KEY, readBuildSession, writeBuildSession, type BuildSession } from "./buildSession"

const SESSION: BuildSession = {
  tracked: {
    results: {
      index: { id: "index", status: "done", artifact_id: "idx1", cache_hit: false, duration_ms: 4 },
      use_case: { id: "use_case", status: "done", artifact_id: "out1" },
    },
    history: { index: { previous: "idx0" } },
  },
  sigs: { index: "sig-index", use_case: "sig-use" },
  transcript: [{ runId: "r1", question: "How long did the survey run?", pipeline: "Working copy", reranker: "no rerank", rows: [{ rank: 1, text: "Six weeks." }], found: 1 }],
  asked: { runId: "r1", question: "How long did the survey run?", pipeline: "Working copy", reranker: "no rerank", signature: "sig-use" },
  comparisonHidden: null,
}

beforeEach(() => window.sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("the Build session", () => {
  it("comes back as it was written, for this tab only", () => {
    writeBuildSession(SESSION)
    expect(readBuildSession()).toEqual(SESSION)
    expect(window.localStorage.getItem(BUILD_SESSION_KEY)).toBeNull()
  })

  it("keeps only finished results: a step left running or waiting is dropped, with its signature", () => {
    writeBuildSession({
      ...SESSION,
      tracked: { ...SESSION.tracked, results: { ...SESSION.tracked.results, chunk: { id: "chunk", status: "running" } } },
      sigs: { ...SESSION.sigs, chunk: "sig-chunk" },
    })
    const back = readBuildSession()!
    expect(Object.keys(back.tracked.results).sort()).toEqual(["index", "use_case"])
    expect(back.sigs.chunk).toBeUndefined()
  })

  it("reads nothing from an empty, broken or foreign value, and never throws", () => {
    expect(readBuildSession()).toBeNull()
    window.sessionStorage.setItem(BUILD_SESSION_KEY, "{not json")
    expect(readBuildSession()).toBeNull()
    window.sessionStorage.setItem(BUILD_SESSION_KEY, JSON.stringify({ tracked: 3 }))
    expect(readBuildSession()).toBeNull()
  })

  it("survives a browser that refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(() => writeBuildSession(SESSION)).not.toThrow()
    expect(readBuildSession()).toBeNull()
  })
})

describe("results the server no longer has", () => {
  it("names the steps whose result is gone (a 404, as after a restart); a network failure keeps them", async () => {
    const { ApiError } = await import("@/api/client")
    const { goneResults } = await import("./buildSession")
    const check = vi.fn(async (id: string) => {
      if (id === "idx1") throw new ApiError(404, "unknown artifact", `/artifacts/${id}`)
      if (id === "out1") throw new TypeError("Failed to fetch")
      return {}
    })
    const results = {
      ...SESSION.tracked.results,
      parse: { id: "parse", status: "done" as const, artifact_id: "p1" },
      failed: { id: "failed", status: "failed" as const, error: "x" },
    }
    expect(await goneResults(results, check)).toEqual(["index"])
    // A failed step has no result to look for.
    expect(check.mock.calls.map((c) => c[0]).sort()).toEqual(["idx1", "out1", "p1"])
  })
})
