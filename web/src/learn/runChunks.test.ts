import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"


import { runChunks } from "./runChunks"

const SHA = "cd".repeat(32)
const PAYLOAD = { chunks: [], doc_id: "d", source_text: "", chunker_meta: {} }

let posts: unknown[] = []
let polls = 0
let finish: "ok" | "fail" = "ok"

beforeEach(() => {
  posts = []
  polls = 0
  finish = "ok"
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/v2/runs" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return ok({ run_id: `r${posts.length}` }, 202)
      }
      if (url.startsWith("/api/v2/runs/")) {
        polls += 1
        if (polls < 2) return ok({ status: "running", events: [] })
        const events =
          finish === "ok"
            ? [{ event: "node_finished", node_id: "d::chunk", step: "chunk", artifact_id: `art${posts.length}`, cache_hit: true, duration_ms: 1, ts: 0 }]
            : [{ event: "node_failed", node_id: "d::chunk", step: "chunk", error: "Traceback\nValueError: overlap must be smaller", ts: 0 }]
        return ok({ status: "finished", ok: finish === "ok", events })
      }
      if (url.startsWith("/api/v2/results/art") && url.endsWith("/payload")) return ok(PAYLOAD)
      return ok({ detail: "not found" }, 404)
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe("runChunks", () => {
  it("runs the real chunker on sample, parse and chunk, and returns the chunk set", async () => {
    const set = await runChunks({
      sha: SHA,
      parse: { transform: "pdfium", config: {} },
      strategy: "token_based",
      config: { max_tokens: 100, overlap: 35 },
      pollMs: 1,
    })
    expect(set).toEqual(PAYLOAD)
    expect(posts[0]).toMatchObject({
      documents: [SHA],
      through: "chunk",
      config: { index: { parse: { use: "pdfium" }, chunk: { use: "token_based", max_tokens: 100, overlap: 35 } } },
    })
  })

  it("throws the last line of the error when the chunker fails", async () => {
    finish = "fail"
    await expect(
      runChunks({ sha: SHA, parse: { transform: "pdfium", config: {} }, strategy: "token_based", config: {}, pollMs: 1 }),
    ).rejects.toThrow("ValueError: overlap must be smaller")
  })

  it("runs the chunker through the chunk step on /api/v2", async () => {
    const calls: { url: string; body?: unknown }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === "/api/v2/runs") return new Response(JSON.stringify({ run_id: "r" }), { status: 202 })
      if (url === "/api/v2/runs/r")
        return new Response(JSON.stringify({ run_id: "r", kind: "run", status: "finished", ok: true, cancel_requested: false, last_event_id: 0,
          events: [{ event: "node_finished", ts: 1, node_id: "d::chunk", step: "chunk", document: "d", artifact_id: "c1", cache_hit: false, duration_ms: 1 }] }))
      return new Response(JSON.stringify({ chunks: [] }))
    }))
    await runChunks({ sha: "s".repeat(64), parse: { transform: "pdfium", config: {} }, strategy: "recursive_character", config: { chunk_size: 400 }, pollMs: 0 })
    expect(calls[0]).toMatchObject({ url: "/api/v2/runs", body: { documents: ["s".repeat(64)], through: "chunk", config: { index: { parse: { use: "pdfium" }, chunk: { use: "recursive_character", chunk_size: 400 } } } } })
    expect(calls.at(-1)?.url).toBe("/api/v2/results/c1/payload")
  })
})
