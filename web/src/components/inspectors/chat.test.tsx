import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chatJson from "@/api/fixtures/output.chat.json"
import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import type { ChatOutput, ChunkSet, FindResult } from "@/api/types"
import { clearPdfCaches } from "@/api/usePdf"
import { titleFor } from "@/state/graph"

import { chatStats, citationPage, segmentKind } from "./chat"
import { ChatInspector } from "./ChatInspector"
import { ArtifactInspector } from "./registry"

const chat = chatJson as unknown as ChatOutput
const chunks = recursiveJson as unknown as ChunkSet
const SHA = chat.payload.citations[0].source_sha
const byN = (n: number) => chat.payload.citations.find((c) => c.n === n)!

let finds: Record<number, FindResult | "error"> = {}
let urls: string[] = []

beforeEach(() => {
  urls = []
  clearPdfCaches()
  finds = {
    1: { rects: [[72, 660, 480, 672], [72, 646, 200, 658]], matched: "exact" },
    2: { rects: [[72, 630, 470, 642]], matched: "normalized" },
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url)
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === `/api/sources/${SHA}/pages`) return ok([1, 2, 3].map((n) => ({ n, width: 612, height: 792 })))
      const m = /\/pages\/(\d+)\/find\?text=(.*)$/.exec(url)
      if (m) {
        const text = decodeURIComponent(m[2])
        const c = chat.payload.citations.find((x) => text && x.cited_text.replace(/\s+/g, " ").trim() === text)
        const f = c ? finds[c.n] : undefined
        if (f === "error") return ok({ detail: "boom" }, 500)
        return ok(f ?? { rects: [], matched: "none" })
      }
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const answer = () => document.querySelector("[data-answer]") as HTMLElement
const view = () => document.querySelector("[data-pdf-view]") as HTMLElement
const rects = () => [...document.querySelectorAll<HTMLElement>("[data-highlight]")]
const how = () => document.querySelector("[data-highlight-how]")?.getAttribute("data-highlight-how")

describe("the fixture matches I-10", () => {
  it("has the payload keys and citation keys, with every edge case", () => {
    expect(Object.keys(chat.payload).sort()).toEqual(["answer", "citations", "model", "question", "stop_reason", "usage"])
    for (const c of chat.payload.citations) {
      expect(Object.keys(c).sort()).toEqual(
        ["bbox", "chunk_id", "cited_text", "doc_end", "doc_start", "element_id", "n", "page", "source_sha", "verified"].sort(),
      )
    }
    const cs = chat.payload.citations
    expect(cs.some((c) => c.verified)).toBe(true)
    expect(cs.some((c) => !c.verified && c.chunk_id !== null)).toBe(true)
    expect(cs.some((c) => c.page === null && c.chunk_id !== null)).toBe(true)
    expect(cs.some((c) => c.chunk_id === null && c.doc_start === null && !c.verified)).toBe(true)
    expect(chat.payload.answer.some((s) => segmentKind(s) === "ungrounded")).toBe(true)
    // Real chunk ids and the real source sha, so the viewer can be exercised.
    const ids = new Set(chunks.chunks.map((c) => c.id))
    expect(cs.filter((c) => c.chunk_id).every((c) => ids.has(c.chunk_id!))).toBe(true)
    expect(SHA).toBe(chunks.doc_id)
    // A verified citation's offsets really do quote the document.
    for (const c of cs.filter((x) => x.verified)) expect(chunks.source_text.slice(c.doc_start!, c.doc_end!)).toBe(c.cited_text)
  })
})

describe("chat helpers", () => {
  it("marks a segment ungrounded only when it has words", () => {
    expect(segmentKind({ text: "It is fast", citations: [1] })).toBe("cited")
    expect(segmentKind({ text: "It is fast", citations: [] })).toBe("ungrounded")
    expect(segmentKind({ text: ". ", citations: [] })).toBe("plain")
  })

  it("counts citations and ungrounded passages", () => {
    expect(chatStats(chat.payload)).toEqual({ citations: 5, verified: 3, unverified: 2, segments: 6, ungrounded: 1 })
  })

  it("finds a page for a citation from its chunk when it has none of its own", () => {
    expect(citationPage(byN(1), chunks)).toEqual({ page: 1, from: "citation" })
    expect(citationPage(byN(4), chunks)).toEqual({ page: 1, from: "chunk" })
    expect(citationPage(byN(4))).toBeNull()
    expect(citationPage(byN(5), chunks)).toBeNull()
  })
})

describe("ChatInspector", () => {
  it("renders the segments in order, with superscript numbers after cited ones", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    expect(answer().textContent).toBe(
      chat.payload.answer.map((s) => s.text + s.citations.join("")).join(""),
    )
    const marks = [...answer().querySelectorAll("sup [data-cite]")].map((m) => m.getAttribute("data-cite"))
    expect(marks).toEqual(["1", "3", "4", "5", "2"])
  })

  it("marks uncited text as not tied to a source, and leaves bare punctuation alone", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    const ungrounded = answer().querySelectorAll<HTMLElement>("[data-segment='ungrounded']")
    expect(ungrounded).toHaveLength(1)
    expect(ungrounded[0].title).toBe("Not tied to a source")
    expect(ungrounded[0].className).toContain("chat-ungrounded")
    expect(ungrounded[0].textContent).toMatch(/most frameworks use it by default/)
  })

  it("never styles an unverified citation like a verified one", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    const mark = (n: number) => answer().querySelector<HTMLElement>(`[data-cite="${n}"]`)!
    expect(mark(1).hasAttribute("data-verified")).toBe(true)
    expect(mark(3).hasAttribute("data-verified")).toBe(false)
    expect(mark(3).getAttribute("aria-label")).toBe("Citation 3, not verified")
    const row = (n: number) => document.querySelector<HTMLElement>(`li[data-citation="${n}"]`)!
    expect(row(1).hasAttribute("data-verified")).toBe(true)
    expect(within(row(3)).getByText(/does not match this quote/)).toBeTruthy()
    expect(within(row(5)).getByText(/outside the retrieved hits/)).toBeTruthy()
    expect(within(row(5)).getByText("not in the hits")).toBeTruthy()
  })

  it("lists each citation with its quote and page", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    const rows = [...document.querySelectorAll<HTMLElement>("li[data-citation]")]
    expect(rows.map((r) => r.getAttribute("data-citation"))).toEqual(["1", "2", "3", "4", "5"])
    expect(rows[0].querySelector("q")!.textContent).toBe(byN(1).cited_text)
    expect(within(rows[0]).getByTestId("citation-page").textContent).toBe("p. 1")
    expect(within(rows[1]).getByTestId("citation-page").textContent).toBe("p. 2")
    // No page of its own: the chunk's page, marked as a guess, and said plainly.
    expect(within(rows[3]).getByTestId("citation-page").textContent).toBe("p. 1?")
    expect(within(rows[3]).getByText("Location not found in the page layout.")).toBeTruthy()
    // No page at all: no viewer offered.
    expect(within(rows[4]).getByTestId("citation-page").textContent).toBe("no page")
    expect(within(rows[4]).queryByRole("button", { name: "Show in PDF" })).toBeNull()
  })

  it("shows the model that actually answered, and token usage, in mono", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    const model = screen.getByTestId("chat-model")
    expect(model.textContent).toBe("claude-opus-4-8")
    expect(model.className).toContain("font-mono")
    expect(screen.getByTestId("chat-input").textContent).toBe("1,847")
    expect(screen.getByTestId("chat-output").textContent).toBe("131")
  })

  it("clicking a number opens its page with the found text highlighted", async () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='1']")!)
    await waitFor(() => expect(how()).toBe("text"))
    await waitFor(() => expect(view().querySelector("[data-pdf-page='1']")).toBeTruthy())
    expect(rects()).toHaveLength(2)
    expect(rects().every((r) => !r.hasAttribute("data-approximate"))).toBe(true)
    expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/found on the page as quoted/)
    expect(urls.some((u) => u.startsWith(`/api/sources/${SHA}/pages/1/find?text=`))).toBe(true)
  })

  it("says when the match needed normalising", async () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='2']")!)
    await waitFor(() => expect(view().querySelector("[data-pdf-page='2']")).toBeTruthy())
    await waitFor(() => expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/collapsing whitespace/))
  })

  it("falls back to the element bbox when the text is not found, and says so", async () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='3']")!)
    await waitFor(() => expect(how()).toBe("element"))
    await waitFor(() => expect(rects()).toHaveLength(1))
    expect(rects()[0].hasAttribute("data-approximate")).toBe(true)
    expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/Showing the whole element it came from/)
  })

  it("falls back the same way when the search fails", async () => {
    finds[1] = "error"
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='1']")!)
    await waitFor(() => expect(how()).toBe("element"))
    expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/Could not search the page/)
  })

  it("a citation with no layout location searches its chunk's page, and says so", async () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='4']")!)
    await waitFor(() => expect(how()).toBe("none"))
    expect(within(view()).getByTestId("pdf-notice").textContent).toMatch(/^Location not found in the page layout\. Searched p\. 1/)
    expect(rects()).toHaveLength(0)
  })

  it("a citation outside the hits opens no page, and selects its row instead", () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    fireEvent.click(answer().querySelector("[data-cite='5']")!)
    expect(view()).toBeNull()
    expect(document.querySelector("li[data-citation='5']")!.className).toContain("bg-selection")
  })

  it("the list's Show in PDF opens the same view", async () => {
    render(<ChatInspector payload={chat.payload} chunkSet={chunks} />)
    const row = document.querySelector<HTMLElement>("li[data-citation='2']")!
    fireEvent.click(within(row).getByRole("button", { name: "Show in PDF" }))
    await waitFor(() => expect(view().querySelector("[data-pdf-page='2']")).toBeTruthy())
    expect(within(view()).getByText("Citation 2")).toBeTruthy()
  })

  it("gives a refusal a clear message", () => {
    render(<ChatInspector payload={{ ...chat.payload, answer: [], citations: [], stop_reason: "refusal" }} />)
    expect(screen.getByTestId("chat-note").textContent).toBe("The model declined to answer this question.")
    expect(screen.getByText("No citations")).toBeTruthy()
  })

  it("is what the registry shows for a chat output", () => {
    render(<ArtifactInspector type="output" data={chat} context={{ chunks }} />)
    expect(document.querySelector("[data-chat-inspector]")).toBeTruthy()
  })

  it("has empty, loading and error screens", () => {
    render(<ChatInspector />)
    expect(screen.getByText("No answer yet")).toBeTruthy()
    cleanup()
    render(<ChatInspector status={{ kind: "error", message: "RuntimeError: No Anthropic API key" }} />)
    expect(screen.getByRole("alert").textContent).toMatch(/No Anthropic API key/)
  })
})

describe("the use case card", () => {
  it("is titled Chat when chat is chosen", () => {
    expect(titleFor({ stage: "use_case", transform: "chat" })).toBe("Chat")
  })
})
