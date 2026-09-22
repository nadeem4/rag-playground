import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { chunkById, chunkStep, cleanStep, parseStep, quoteSource, rerankStep, retrieveStep, RUN } from "@/learn/e2e"
import { readProgress, resetProgressForTests } from "@/state/lessons"

import { EndToEndLesson } from "./EndToEndLesson"

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
})
afterEach(cleanup)

function lesson() {
  const onRun = vi.fn()
  const onChat = vi.fn()
  render(<EndToEndLesson onRun={onRun} onChat={onChat} />)
  return { onRun, onChat }
}

const stepHeadings = () =>
  screen
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent)

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

  it("walks back from Rerank to Parse, with words computed from the run", () => {
    lesson()
    expect(stepHeadings()).toEqual([
      rerankStep(RUN).title,
      retrieveStep(RUN).title,
      chunkStep(RUN).title,
      cleanStep(RUN).title,
      parseStep(RUN).title,
    ])
    for (const w of [...rerankStep(RUN).words, ...parseStep(RUN).words, ...cleanStep(RUN).words]) expect(screen.getByText(w)).toBeTruthy()
  })

  it("shows every candidate on request", () => {
    lesson()
    const rerank = screen.getByRole("region", { name: rerankStep(RUN).title })
    fireEvent.click(within(rerank).getByRole("button", { name: `Show all ${RUN.pool.length} candidates` }))
    expect(within(rerank).getByText(`#${RUN.pool.length}`)).toBeTruthy()
  })

  it("reads another chunk when its bar is clicked", () => {
    lesson()
    const chunk = screen.getByRole("region", { name: chunkStep(RUN).title })
    const bars = within(chunk).getAllByRole("button", { name: /^Chunk \d+,/ })
    expect(bars).toHaveLength(RUN.chunks.length)
    const top = chunkById(RUN, RUN.mmr[0])
    expect(bars[top.ordinal].getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(bars[0])
    const c = RUN.chunks[0]
    expect(within(chunk).getByText(`Chunk 1, ${c.end - c.start} characters, page ${c.page_span[0]}. Click a bar to read another chunk.`)).toBeTruthy()
  })

  it("shows the removed duplicate and the page-1 blocks", () => {
    lesson()
    const clean = screen.getByRole("region", { name: cleanStep(RUN).title })
    expect(within(clean).getByText(`page ${RUN.removed[0].page}, removed as a duplicate`)).toBeTruthy()
    const parse = screen.getByRole("region", { name: parseStep(RUN).title })
    expect(within(parse).getAllByTestId("block")).toHaveLength(RUN.elements.filter((e) => e.page === 1).length)
  })

  it("ends with Mark as done and Next: Chunking", () => {
    lesson()
    const next = screen.getByRole("link", { name: "Next: Chunking" })
    expect(next.getAttribute("href")).toBe("/learn/chunking")
    fireEvent.click(screen.getByRole("link", { name: "Mark as done" }))
    expect(readProgress()).toEqual({ "end-to-end": true })
  })

  it("has no em-dashes or en-dashes", () => {
    lesson()
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})
