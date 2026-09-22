import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"
import { chunkById, chunkStep, cleanStep, parseStep, quoteSource, rerankStep, retrieveStep, RUN } from "@/learn/e2e"
import { readProgress, resetProgressForTests } from "@/state/lessons"

import { EndToEndLesson } from "./EndToEndLesson"

const SHA = "34".repeat(32)

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b))
      if (url === "/api/learn/document") return ok({ filename: RUN.filename, page_count: RUN.page_count, text: "A retriever scores each chunk as a whole." })
      if (url === `/api/sources/${SHA}/pages`) return ok([{ n: 1, width: 612, height: 792 }])
      if (url.startsWith(`/api/sources/${SHA}/pages/1/find`)) return ok({ rects: [], matched: "none" })
      return new Response("{}", { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function lesson() {
  const onRun = vi.fn()
  const onChat = vi.fn()
  render(<EndToEndLesson sha={SHA} onRun={onRun} onChat={onChat} />)
  return { onRun, onChat }
}

const rail = () => screen.getByRole("navigation", { name: "Steps" })
const steps = () => within(rail()).getAllByRole("button")
const stepPanel = () => screen.getByRole("region", { name: "The step" })

/** Open the step whose title matches, and return the step panel. */
function open(title: string) {
  fireEvent.click(within(rail()).getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }))
  return stepPanel()
}

describe("How RAG works, end to end", () => {
  it("says it shows a recorded run, and Run it yourself opens Build with the same graph", () => {
    const { onRun } = lesson()
    expect(screen.getByRole("heading", { level: 1, name: "How RAG works, end to end" })).toBeTruthy()
    expect(screen.getByText(/shows a recorded run of this playground/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Run it yourself" }))
    expect(onRun).toHaveBeenCalledOnce()
    expect(screen.getByText(`"${RUN.question}"`)).toBeTruthy()
    expect(screen.getByText(`asked of ${RUN.filename}, ${RUN.page_count} pages`)).toBeTruthy()
  })

  it("opens on what search found: the reranker's picks with their retriever rank", () => {
    lesson()
    const panel = screen.getByRole("tabpanel")
    expect(screen.getByRole("tab", { name: "What search found" }).getAttribute("aria-selected")).toBe("true")
    const hits = within(panel).getAllByRole("listitem")
    expect(hits).toHaveLength(RUN.mmr.length)
    expect(within(hits[0]).getByText(new RegExp(`ranked 1 of ${RUN.pool.length} by the retriever`))).toBeTruthy()
  })

  it("labels the model's answer as an example, quotes the sentence a number points to, and offers Build with a chat step", () => {
    const { onChat } = lesson()
    fireEvent.click(screen.getByRole("tab", { name: "With a model" }))
    const panel = screen.getByRole("tabpanel")
    expect(within(panel).getByText("An example answer")).toBeTruthy()
    expect(within(panel).getByText(/This answer is an example written for this page/)).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Source 1" }))
    const src = quoteSource(RUN, "A retriever scores each chunk as a whole.")!
    expect(within(panel).getByText(`Chunk ${src.chunk}, page ${src.page} of the PDF.`)).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Open Build with a chat step" }))
    expect(onChat).toHaveBeenCalledOnce()
  })

  it("steps back from Rerank to Parse, with words computed from the run", () => {
    lesson()
    expect(steps().map((b) => b.textContent)).toEqual([
      `1What came back`,
      `2${rerankStep(RUN).title}`,
      `3${retrieveStep(RUN).title}`,
      `4${chunkStep(RUN).title}`,
      `5${cleanStep(RUN).title}`,
      `6${parseStep(RUN).title}`,
      `7Recap`,
    ])
    for (const step of [rerankStep(RUN), cleanStep(RUN), parseStep(RUN)]) {
      const panel = open(step.title)
      expect(within(panel).getByRole("heading", { level: 2, name: step.title })).toBeTruthy()
      for (const w of step.words) expect(within(panel).getByText(w)).toBeTruthy()
    }
  })

  it("shows every candidate on request", () => {
    lesson()
    const panel = open(rerankStep(RUN).title)
    fireEvent.click(within(panel).getByRole("button", { name: `Show all ${RUN.pool.length} candidates` }))
    expect(within(panel).getByText(`#${RUN.pool.length}`)).toBeTruthy()
  })

  it("reads another chunk when its bar is clicked", () => {
    lesson()
    const panel = open(chunkStep(RUN).title)
    const bars = within(panel).getAllByRole("button", { name: /^Chunk \d+,/ })
    expect(bars).toHaveLength(RUN.chunks.length)
    const top = chunkById(RUN, RUN.mmr[0])
    expect(bars[top.ordinal].getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(bars[0])
    const c = RUN.chunks[0]
    expect(within(panel).getByText(`Chunk 1, ${c.end - c.start} characters, page ${c.page_span[0]}. Click a bar to read another chunk.`)).toBeTruthy()
  })

  it("shows the removed duplicate and the page-1 blocks", () => {
    lesson()
    expect(within(open(cleanStep(RUN).title)).getByText(`page ${RUN.removed[0].page}, removed as a duplicate`)).toBeTruthy()
    expect(within(open(parseStep(RUN).title)).getAllByTestId("block")).toHaveLength(RUN.elements.filter((e) => e.page === 1).length)
  })

  it("recaps what the lesson showed, then Mark as done and Next: Chunking", () => {
    lesson()
    const panel = open("Recap")
    expect(within(panel).getByText(/One question travelled through parse, clean, chunk, retrieve and rerank/)).toBeTruthy()
    expect(within(panel).getByRole("link", { name: "Next: Chunking" }).getAttribute("href")).toBe("/learn/chunking")
    fireEvent.click(within(panel).getByRole("link", { name: "Mark as done" }))
    expect(readProgress()).toEqual({ "end-to-end": true })
  })

  it("has no em-dashes or en-dashes", () => {
    lesson()
    for (let i = 0; i < steps().length; i++) {
      fireEvent.click(steps()[i])
      expect(document.body.textContent).not.toMatch(/[–—]/)
    }
  })
})
