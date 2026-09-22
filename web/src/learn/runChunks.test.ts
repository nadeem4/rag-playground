import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TEST_REGISTRY } from "@/state/testRegistry"

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
      if (url === "/api/runs" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return ok({ run_id: `r${posts.length}` }, 202)
      }
      if (url.startsWith("/api/runs/")) {
        polls += 1
        if (polls < 2) return ok({ status: "running", events: [] })
        const events =
          finish === "ok"
            ? [{ event: "node_finished", node_id: "chunk", artifact_id: `art${posts.length}`, cache_hit: true, duration_ms: 1, ts: 0 }]
            : [{ event: "node_failed", node_id: "chunk", error: "Traceback\nValueError: overlap must be smaller", ts: 0 }]
        return ok({ status: "finished", ok: finish === "ok", events })
      }
      if (url.startsWith("/api/artifacts/art") && url.endsWith("/payload")) return ok(PAYLOAD)
      return ok({ detail: "not found" }, 404)
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe("runChunks", () => {
  it("runs the real chunker on sample, parse and chunk, and returns the chunk set", async () => {
    const set = await runChunks({
      registry: TEST_REGISTRY,
      sha: SHA,
      parse: { transform: "pdfium", config: {} },
      strategy: "token_based",
      config: { max_tokens: 100, overlap: 35 },
      pollMs: 1,
    })
    expect(set).toEqual(PAYLOAD)
    const body = posts[0] as { graph: { nodes: { id: string; transform: string; config: unknown }[]; edges: unknown[] }; targets: string[] }
    expect(body.targets).toEqual(["chunk"])
    expect(body.graph.nodes.map((n) => [n.id, n.transform])).toEqual([
      ["source", "upload"],
      ["parse", "pdfium"],
      ["chunk", "token_based"],
    ])
    expect(body.graph.nodes[0].config).toEqual({ sha: SHA, filename: "chunking-primer.pdf" })
    expect(body.graph.nodes[2].config).toEqual({ max_tokens: 100, overlap: 35 })
    expect(body.graph.edges).toEqual([
      { src: "source", dst: "parse", port: "file" },
      { src: "parse", dst: "chunk", port: "doc" },
    ])
  })

  it("throws the last line of the error when the chunker fails", async () => {
    finish = "fail"
    await expect(
      runChunks({ registry: TEST_REGISTRY, sha: SHA, parse: { transform: "pdfium", config: {} }, strategy: "token_based", config: {}, pollMs: 1 }),
    ).rejects.toThrow("ValueError: overlap must be smaller")
  })
})
