import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Chunk, ChunkSet, LearnChunking } from "@/api/types"
import { clearPdfCaches } from "@/api/usePdf"
import { TEST_REGISTRY } from "@/state/testRegistry"

import { clearChunkRunCache } from "@/learn/runChunks"

import { readProgress } from "@/state/lessons"

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
  clearPdfCaches()
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
      if (url === "/api/learn/document") return ok({ filename: "chunking-primer.pdf", page_count: 3, text: DOC })
      if (url === `/api/sources/${SHA}/pages`) return ok([{ n: 1, width: 612, height: 792 }])
      if (url.startsWith(`/api/sources/${SHA}/pages/1/find`)) return ok({ rects: [], matched: "none" })
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

const rail = () => screen.getByRole("navigation", { name: "Steps" })
const railStep = (name: RegExp | string) => within(rail()).getByRole("button", { name })

/** Open the lesson and walk to the step that asks challenge 1. */
async function open() {
  render(<ChunkingLesson registry={TEST_REGISTRY} sha={SHA} pollMs={1} debounceMs={20} />)
  await screen.findByRole("navigation", { name: "Steps" })
  fireEvent.click(railStep(/Predict/))
  return await screen.findByRole("region", { name: "Challenge" })
}

/** The step that shows the chunker's real output. */
function result() {
  fireEvent.click(railStep(/See the result/))
  return screen.getByRole("region", { name: "The step" })
}

const lastChunkConfig = () => posts[posts.length - 1].graph.nodes.find((n) => n.id === "chunk")!

describe("Chunking lesson", () => {
  it("opens on the idea, in a shell of steps with the document beside it", async () => {
    render(<ChunkingLesson registry={TEST_REGISTRY} sha={SHA} pollMs={1} debounceMs={20} />)
    await screen.findByRole("navigation", { name: "Steps" })
    expect(within(rail()).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "1Read the idea",
      "2Predict",
      "3See the result",
      "4The other challenges",
      "5Recap",
    ])
    expect(screen.getByText(/predict what a setting will do/)).toBeTruthy()
    expect(screen.getByText(/Getting a prediction wrong is fine, and is the point\./)).toBeTruthy()
    expect(screen.getByRole("region", { name: "The document" })).toBeTruthy()
  })

  it("asks challenge 1 as a question, under a label that says it is the reader's turn", async () => {
    const ch = await open()
    expect(within(ch).getByRole("heading", { name: "Your turn: predict" })).toBeTruthy()
    expect(within(ch).getByText(/Challenge 1 of 4: Shrink the chunks/)).toBeTruthy()
    const question = within(ch).getByText(new RegExp(`${ANSWER.length} characters long`))
    expect(question.textContent?.trim().endsWith("?")).toBe(true)
    expect(within(ch).getByText(/only 60 characters/)).toBeTruthy()
    // The buttons read as answers to that question.
    expect(within(ch).getByRole("button", { name: "Yes, it stays whole" })).toBeTruthy()
    expect(within(ch).getByRole("button", { name: "No, it gets cut" })).toBeTruthy()
  })

  it("an answer runs the real chunker with the challenge's settings and states the real outcome", async () => {
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "No, it gets cut" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    expect(within(ch).getByText(/It gets cut, across chunks 1 and 2\./)).toBeTruthy()
    const chunk = lastChunkConfig()
    expect(chunk.transform).toBe("recursive_character")
    expect(chunk.config).toEqual({ chunk_size: 60, chunk_overlap: 0 })
    // Every choice is locked once answered.
    expect((within(ch).getByRole("button", { name: "Yes, it stays whole" }) as HTMLButtonElement).disabled).toBe(true)
    // The next step shows the real chunks, the answer underlined, and the cut noted.
    const step = result()
    const list = within(step).getByRole("list", { name: "Chunks" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    expect(list.querySelectorAll("[data-answer]").length).toBe(2)
    expect(within(list).getByText("The answer sentence is cut here and continues in chunk 2.")).toBeTruthy()
  })

  it("draws the boundaries on the document, with the answer sentence still marked", async () => {
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "No, it gets cut" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    const step = result()
    fireEvent.click(within(step).getByRole("tab", { name: "Document with boundaries" }))
    expect(within(step).queryByRole("list", { name: "Chunks" })).toBeNull()
    const reading = step.querySelector("[data-reading]")!
    // The whole parsed text is drawn once, cut into segments by the chunks.
    expect([...reading.querySelectorAll("[data-seg]")].map((s) => s.textContent).join("")).toBe(DOC)
    expect([...reading.querySelectorAll("[data-answer]")].map((m) => m.textContent).join("")).toBe(DOC.slice(A0, A0 + ANSWER.length))
    fireEvent.click(within(step).getByRole("tab", { name: "Chunk cards" }))
    expect(within(step).getByRole("list", { name: "Chunks" })).toBeTruthy()
  })

  it("shows the real result when it disagrees with what the challenge expected", async () => {
    outcome = () => WHOLE
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "No, it gets cut" }))
    await waitFor(() => expect(within(ch).getByText("Not quite.")).toBeTruthy())
    expect(within(ch).getByText(/It stays whole, in chunk 2\./)).toBeTruthy()
    expect(within(ch).queryByText(/It gets cut, across/)).toBeNull()
  })

  it("tints repeated text when the chunks overlap", async () => {
    await open()
    // The other challenges step starts at challenge 2 and walks on to the last.
    fireEvent.click(railStep(/The other challenges/))
    let ch = screen.getByRole("region", { name: "Challenge" })
    for (let i = 0; i < 2; i++) {
      fireEvent.click(within(ch).getAllByRole("button")[0])
      await waitFor(() => expect(within(ch).getByRole("button", { name: "Next challenge" })).toBeTruthy())
      fireEvent.click(within(ch).getByRole("button", { name: "Next challenge" }))
      ch = screen.getByRole("region", { name: "Challenge" })
    }
    expect(within(ch).getByText(/Challenge 4 of 4: Overlap to the rescue/)).toBeTruthy()
    fireEvent.click(within(ch).getByRole("button", { name: "Yes, in one chunk" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    const list = screen.getByRole("list", { name: "Chunks" })
    expect(list.querySelectorAll("[data-repeated]").length).toBe(1)
    expect(within(ch).getByRole("button", { name: "Start again" })).toBeTruthy()
  })

  it("sliders explore after a challenge: changes rerun the chunker once they settle", async () => {
    const ch = await open()
    fireEvent.click(within(ch).getByRole("button", { name: "No, it gets cut" }))
    await waitFor(() => expect(within(ch).getByText("You were right.")).toBeTruthy())
    result()
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
    fireEvent.click(within(ch).getByRole("button", { name: "No, it gets cut" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/ValueError: bad settings/))
  })

  it("recaps what the lesson showed, then offers Mark as done and Next: How citations work", async () => {
    await open()
    fireEvent.click(railStep(/Recap/))
    const step = screen.getByRole("region", { name: "The step" })
    expect(within(step).getByText("Overlap repeats the end of one chunk at the start of the next, so a sentence on a border survives.")).toBeTruthy()
    expect(within(step).getByRole("link", { name: "Next: How citations work" }).getAttribute("href")).toBe("/learn/citations")
    fireEvent.click(within(step).getByRole("link", { name: "Mark as done" }))
    expect(readProgress()).toMatchObject({ chunking: true })
  })
})
