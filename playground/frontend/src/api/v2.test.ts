import { afterEach, describe, expect, it, vi } from "vitest"

import { v2 } from "./v2"

afterEach(() => vi.unstubAllGlobals())

function capture(body: unknown = {}, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), { status })
    }),
  )
  return calls
}

describe("the /api/v2 client", () => {
  it("runs one card with through, sending keys in headers only", async () => {
    const calls = capture({ run_id: "r1" })
    const config = { index: { parse: { use: "pdfium" }, chunk: { use: "recursive_character" }, store: { use: "lancedb" } } }
    await v2.createRun({ config, documents: ["a".repeat(64)], through: "chunk" }, { keys: { anthropic: "sk-test" } })
    expect(calls[0].url).toBe("/api/v2/runs")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ config, documents: ["a".repeat(64)], through: "chunk" })
    expect((calls[0].init?.headers as Record<string, string>)["X-Anthropic-Api-Key"]).toBe("sk-test")
    expect(String(calls[0].init?.body)).not.toContain("sk-test")
  })

  it("names the document routes and the page image the way pandion-api serves them", () => {
    expect(v2.pageImageUrl("abc", 2, 1.5)).toBe("/api/v2/documents/abc/pages/2?scale=1.5")
    expect(v2.documentFileUrl("abc")).toBe("/api/v2/documents/abc/file")
    expect(v2.eventsUrl("r1", 4)).toBe("/api/v2/runs/r1/events?last_event_id=4")
  })

  it("uploads one question set for several documents, each sha a documents field", async () => {
    const calls = capture({ documents: ["a", "b"], questions: [] })
    await v2.uploadQuestionSetAcross(["a", "b"], new File(["[]"], "golden.json"))
    expect(calls[0].url).toBe("/api/v2/questions")
    const body = calls[0].init?.body as FormData
    expect(body.getAll("documents")).toEqual(["a", "b"])
    expect((body.get("file") as File).name).toBe("golden.json")
  })

  it("keeps a problem list as the error's detail", async () => {
    capture({ detail: { problems: ["index.chunk: chunk_overlap must be smaller than chunk_size."] } }, 422)
    await expect(v2.validate({})).rejects.toMatchObject({ status: 422, detail: { problems: [expect.stringContaining("index.chunk")] } })
  })
})
