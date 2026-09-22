import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Chunk, ChunkSet, LearnChunking } from "@/api/types"
import { TEST_REGISTRY } from "@/state/testRegistry"

import { clearChunkRunCache } from "@/learn/runChunks"

import { ChunkingLesson } from "./ChunkingLesson"

const SHA = "ef".repeat(32)
const ANSWER = "When a boundary falls in the middle of an explanation, neither half scores well."
const DOC = `A retriever scores each chunk as a whole. ${ANSWER.replace("explanation, ", "explanation,\n")} The model then gets a passage.`
const A0 = DOC.indexOf("When")

const DATA: LearnChunking = {
  question: "Why do chunk boundaries matter?",
  answer_sentence: ANSWER,
  sentence_chars: ANSWER.length,
  sentence_tokens: 16,
  parse: { transform: "pdfium", config: {} },
  challenges: [
    { id: "shrink", title: "Shrink the chunks", strategy: "recursive_character", config: { chunk_size: 60, chunk_overlap: 0 }, expect_whole: false },
    { id: "room", title: "Give it room", strategy: "recursive_character", config: { chunk_size: 300, chunk_overlap: 0 }, expect_whole: true },
    { id: "naive", title: "The naive way", strategy: "token_based", config: { max_tokens: 20, overlap: 0 }, expect_whole: false },
    { id: "overlap", title: "Overlap to the rescue", strategy: "token_based", config: { max_tokens: 20, overlap: 18 }, expect_whole: true },
  ],
}

function chunkSet(spans: [number, number][]): ChunkSet {
  const chunks = spans.map(
    ([s, e], i): Chunk => ({
      id: `c${i}`,
      text: DOC.slice(s, e),
      embed_text: null,
      start_char: s,
      end_char: e,
      token_count: 10,
      kind: "chunk",
      parent_id: null,
      level: 0,
      ordinal: i,
      doc_id: "d",
      heading_path: [],
      source_element_ids: [],
      page_span: [1, 1],
      metadata: {},
    }),
  )
  return { chunks, doc_id: "d", source_text: DOC, chunker_meta: {} }
}

const CUT = chunkSet([[0, A0 + 20], [A0 + 20, DOC.length]])
const WHOLE = chunkSet([[0, A0 - 1], [A0, DOC.length]])
const OVERLAPPED = chunkSet([[0, A0 + 20], [A0 - 5, DOC.length]])

/** Which chunk set a config gets. Tests overwrite it to make the real result disagree. */
let outcome: (config: Record<string, unknown>) => ChunkSet
let posts: { graph: { nodes: { id: string; transform: string; config: Record<string, unknown> }[] } }[] = []
let failRuns = false
/** Artifact ids stay unique across tests: payloads are cached for the session. */
let seq = 0
const configs = new Map<string, Record<string, unknown>>()

beforeEach(() => {
  posts = []
  failRuns = false
  clearChunkRunCache()
  outcome = (c) => {
    if (c.overlap) return OVERLAPPED
    if (c.chunk_size === 300) return WHOLE
    return CUT
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/learn/chunking") return ok(DATA)
      if (url === "/api/stages") return ok({ chunk: { what: "x", lesson: ["Before a search can find anything, the document has to be cut."] } })
      if (url === "/api/runs" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return ok({ run_id: `r${posts.length}` }, 202)
      }
      const run = /^\/api\/runs\/r(\d+)$/.exec(url)
      if (run) {
        const i = Number(run[1]) - 1
        const id = `a${++seq}`
        configs.set(id, posts[i].graph.nodes.find((n) => n.id === "chunk")!.config)
        if (failRuns) return ok({ status: "finished", ok: false, events: [{ event: "node_failed", node_id: "chunk", error: "Traceback\nValueError: bad settings", ts: 0 }] })
        return ok({ status: "finished", ok: true, events: [{ event: "node_finished", node_id: "chunk", artifact_id: id, cache_hit: true, duration_ms: 1, ts: 0 }] })
      }
      const art = /^\/api\/artifacts\/(a\d+)\/payload$/.exec(url)
      if (art) return ok(outcome(configs.get(art[1])!))
      return ok({ detail: "not found" }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open() {
  render(<ChunkingLesson registry={TEST_REGISTRY} sha={SHA} pollMs={1} debounceMs={20} />)
  return await screen.findByRole("region", { name: "Challenge" })
}

const lastChunkConfig = () => posts[posts.length - 1].graph.nodes.find((n) => n.id === "chunk")!

describe("Chunking lesson", () => {
  it("asks challenge 1 with the real sentence length and the challenge's own settings", async () => {
    const ch = await open()
    expect(within(ch).getByText("Shrink the chunks")).toBeTruthy()
    expect(within(ch).getByText(/Challenge 1 of 4/)).toBeTruthy()
    expect(within(ch).getByText(new RegExp(`${ANSWER.length} characters long`))).toBeTruthy()
    expect(within(ch).getByText(/only 60 characters/)).toBeTruthy()
  })

  it("an answer runs the real chunker with the challenge's settings and states the real outcome", async () => {
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "It gets cut" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    expect(within(ch).getByText(/It gets cut, across chunks 1 and 2\./)).toBeTruthy()
    const chunk = lastChunkConfig()
    expect(chunk.transform).toBe("recursive_character")
    expect(chunk.config).toEqual({ chunk_size: 60, chunk_overlap: 0 })
    // The real chunks are shown, the answer underlined, and the cut is noted.
    const list = screen.getByRole("list", { name: "Chunks" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    expect(list.querySelectorAll("[data-answer]").length).toBe(2)
    expect(within(list).getByText("The answer sentence is cut here and continues in chunk 2.")).toBeTruthy()
    // Every choice is locked once answered.
    expect((within(ch).getByRole("button", { name: "It stays whole" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the real result when it disagrees with what the challenge expected", async () => {
    outcome = () => WHOLE
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "It gets cut" }))
    await waitFor(() => expect(within(ch).getByText("Not quite.")).toBeTruthy())
    expect(within(ch).getByText(/It stays whole, in chunk 2\./)).toBeTruthy()
    expect(within(ch).queryByText(/It gets cut, across/)).toBeNull()
  })

  it("tints repeated text when the chunks overlap", async () => {
    const ch = await open()
    for (let i = 0; i < 3; i++) {
      fireEvent.click(within(ch).getAllByRole("button")[0])
      await waitFor(() => expect(within(ch).getByRole("button", { name: "Next challenge" })).toBeTruthy())
      fireEvent.click(within(ch).getByRole("button", { name: "Next challenge" }))
    }
    expect(within(ch).getByText("Overlap to the rescue")).toBeTruthy()
    fireEvent.click(within(ch).getByRole("button", { name: "Yes, in one chunk" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    const list = screen.getByRole("list", { name: "Chunks" })
    expect(list.querySelectorAll("[data-repeated]").length).toBe(1)
    expect(within(ch).getByRole("button", { name: "Start again" })).toBeTruthy()
  })

  it("sliders explore after a challenge: changes rerun the chunker once they settle", async () => {
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "It gets cut" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    const before = posts.length
    const size = screen.getByLabelText("Chunk size") as HTMLInputElement
    fireEvent.change(size, { target: { value: "200" } })
    fireEvent.change(size, { target: { value: "310" } })
    await waitFor(() => expect(posts.length).toBe(before + 1))
    expect(lastChunkConfig().config).toEqual({ chunk_size: 310, chunk_overlap: 0 })
  })

  it("shows the error when a run fails", async () => {
    failRuns = true
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "It gets cut" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/ValueError: bad settings/))
  })
})
