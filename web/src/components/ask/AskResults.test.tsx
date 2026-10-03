import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchJson from "@/api/fixtures/output.search.json"
import chatJson from "@/api/fixtures/output.chat.json"
import type { Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry, RetrievalResult } from "@/api/types"
import { play } from "@/lib/flip"
import { sampleGraph, setReranker, setUseCase, type PipelineGraph } from "@/state/graph"

import { AskPanel, type AskPanelProps } from "./AskPanel"
import { resetMotionMemory, slideTiming } from "./AskResults"

vi.mock("@/lib/flip", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/flip")>()), play: vi.fn() }))

const LIVE = liveRegistry as unknown as Registry
const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null }
const UPLOAD = { sha: "ab".repeat(32), filename: "report.pdf" }
const hybrid = hybridJson as unknown as RetrievalResult

/** The hybrid result reranked: the sixth hit first, the fifth dropped. Prior ranks 6, 1, 2, 4, 3. */
function reranked(): RetrievalResult {
  const order = [5, 0, 1, 3, 2]
  return {
    ...hybrid,
    hits: order.map((i, k) => ({ ...hybrid.hits[i], rank: k + 1, prior_rank: hybrid.hits[i].rank, prior_score: hybrid.hits[i].score })),
  }
}

let payloads: Record<string, unknown>

beforeEach(() => {
  vi.mocked(play).mockClear()
  resetMotionMemory()
  resetSampleQuestionsCache()
  payloads = {
    idx1: { doc_count: 6 },
    ret1: hybrid,
    rr1: reranked(),
    rr2: reranked(),
    rr3: reranked(),
    rrScored: { ...reranked(), hits: reranked().hits.map((h, i) => ({ ...h, score: 8.21 - i })) },
    out1: searchJson,
    chat1: chatJson,
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      const payload = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (payload && payloads[payload[1]] !== undefined) return ok(await payloads[payload[1]])
      if (url === "/api/artifacts/rr1" || url === "/api/artifacts/rr2") {
        return ok({ id: "rr1", meta: { note: "Scored 6 candidates with MiniLM in 0.2 s. 4 of the top 5 changed place." } })
      }
      if (url === "/api/samples") return ok([])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const done = (id: string, artifact_id: string): NodeState => ({ id, status: "done", artifact_id })

function props(graph: PipelineGraph, results: Record<string, NodeState>): AskPanelProps {
  return {
    graph,
    registry: LIVE,
    results: { index: done("index", "idx1"), ...results },
    stale: new Set(),
    busy: false,
    keys: NO_KEYS,
    server: null,
    explanations: {},
    errors: {},
    keyNotice: null,
    asked: null,
    transcript: [],
    comparisonHidden: null,
    onComparison: vi.fn(),
    onLog: vi.fn(),
    onConfig: vi.fn(),
    onTransform: vi.fn(),
    onReranker: vi.fn(),
    onUseCase: vi.fn(),
    onAsk: vi.fn(),
  }
}

const withCrossEncoder = () => setReranker(sampleGraph(LIVE, UPLOAD), LIVE, "cross_encoder")
const RERANKED = { retrieve: done("retrieve", "ret1"), rerank_1: done("rerank_1", "rr1"), use_case: done("use_case", "out1") }
const badges = () => screen.queryAllByTestId("badge").map((b) => b.textContent)

/** The panel with the comparison state held above it, as Shell holds it. */
function Panel(p: AskPanelProps) {
  const [hidden, setHidden] = useState<string | null>(null)
  return <AskPanel {...p} comparisonHidden={hidden} onComparison={setHidden} />
}

describe("the comparison, with a reranker", () => {
  it("shows the search order against the reranked order, with badges from prior_rank", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    expect(await screen.findByRole("heading", { name: "Search order against the reranked order" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Hide comparison" })).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Search order, 6 candidates" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })).toBeTruthy()
    await waitFor(() => expect(badges()).toEqual(["up from #6", "down from #1", "down from #2", "stayed #4", "down from #3"]))
    // The rank 1 hit came from rank 6.
    const top = document.querySelector('[data-column="reranked"] [data-hit-row="1"]') as HTMLElement
    expect(within(top).getByTestId("badge").textContent).toBe("up from #6")
    expect(within(top).getByTestId("badge").className).toContain("font-sans")
    expect(within(top).getByTestId("badge").className).not.toContain("font-mono")
    // The left column marks only the piece the reranker dropped: the fifth search hit.
    const left = document.querySelector('[data-column="search"]') as HTMLElement
    expect(within(left).getAllByText("Not kept")).toHaveLength(1)
    expect(within(left.querySelector<HTMLElement>('[data-hit-row="5"]')!).getByText("Not kept")).toBeTruthy()
    expect(left.textContent!.match(/kept/g)).toHaveLength(1)
    expect(await screen.findByText("Scored 6 candidates with MiniLM in 0.2 s. 4 of the top 5 changed place.")).toBeTruthy()
  })

  it("states the movement count once, in the run note under the right list", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    const note = await screen.findByText("Scored 6 candidates with MiniLM in 0.2 s. 4 of the top 5 changed place.")
    expect((document.querySelector('[data-column="reranked"]') as HTMLElement).contains(note)).toBe(true)
    expect(screen.queryByTestId("fact-moved")).toBeNull()
    expect(document.body.textContent).not.toMatch(/Moved \d+ of/)
  })

  it("collapsing hides the search order and keeps the reranked list with its badges", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(screen.queryByRole("heading", { name: "Search order, 6 candidates" })).toBeNull()
    expect(document.querySelector('[data-column="search"]')).toBeNull()
    expect(screen.getByRole("button", { name: "Show comparison" })).toBeTruthy()
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(badges()[0]).toBe("up from #6")
    fireEvent.click(screen.getByRole("button", { name: "Show comparison" }))
    expect(await screen.findByRole("heading", { name: "Search order, 6 candidates" })).toBeTruthy()
  })

  it("collapsed, the title row is the right list's title beside Show comparison", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(screen.queryByRole("heading", { name: "Search order against the reranked order" })).toBeNull()
    const show = screen.getByRole("button", { name: "Show comparison" })
    expect(within(show.parentElement!).getByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })).toBeTruthy()
    expect(screen.getAllByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })).toHaveLength(1)
  })

  it("the open state is held above the panel, keyed by the rerank result", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    render(<AskPanel {...p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(p.onComparison).toHaveBeenCalledWith("rr1")
    cleanup()
    render(<AskPanel {...p} comparisonHidden="rr1" />)
    expect(await screen.findByRole("button", { name: "Show comparison" })).toBeTruthy()
    cleanup()
    // Hidden for another result: this one is open.
    render(<AskPanel {...p} comparisonHidden="rr0" />)
    expect(await screen.findByRole("button", { name: "Hide comparison" })).toBeTruthy()
  })

  it("reopens after a new run with the same reranker", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(screen.getByRole("button", { name: "Show comparison" })).toBeTruthy()
    rerender(<Panel {...p} results={{ ...p.results, rerank_1: done("rerank_1", "rr2") }} />)
    expect(await screen.findByRole("button", { name: "Hide comparison" })).toBeTruthy()
  })

  it("shows no single list while the rerank result is missing, so a failed rerank explains itself", async () => {
    render(
      <AskPanel
        {...props(withCrossEncoder(), {
          retrieve: done("retrieve", "ret1"),
          rerank_1: { id: "rerank_1", status: "failed", error: "RuntimeError: the model did not load" },
          use_case: { id: "use_case", status: "skipped" },
        })}
      />,
    )
    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("RuntimeError: the model did not load")).toBeTruthy()
    // Give the retrieve payload time to load: still no list under the no-reranker heading.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole("heading", { name: /in search order$/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Hide comparison" })).toBeNull()
  })

  it("reopens when the reranker changes", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(screen.getByRole("button", { name: "Show comparison" })).toBeTruthy()
    const mmr = setReranker(p.graph, LIVE, "mmr")
    rerender(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr2") }} />)
    expect(await screen.findByRole("button", { name: "Hide comparison" })).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "After rerank, MMR, 5 kept" })).toBeTruthy()
  })
})

describe("the two result motions", () => {
  const rows = (column: string) => [...document.querySelectorAll<HTMLElement>(`[data-column="${column}"] [data-hit-row]`)]

  it("slides the reranked hits once per rerank result, from the place of their prior rank", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    const [container, before, timing] = vi.mocked(play).mock.calls[0]
    expect(container).toBe(document.querySelector('[data-column="reranked"]'))
    // Every kept hit has a place to come from; the one from #6 starts below the five.
    expect([...before.keys()].sort()).toEqual(rows("reranked").map((r) => r.dataset.flipKey).sort())
    expect(timing).toEqual({ duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" })
    // A rerender, a collapse and an expand do not play it again.
    rerender(<Panel {...p} />)
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    fireEvent.click(screen.getByRole("button", { name: "Show comparison" }))
    await screen.findByRole("heading", { name: "Search order, 6 candidates" })
    expect(play).toHaveBeenCalledTimes(1)
    // A new rerank result plays once more.
    rerender(<Panel {...p} results={{ ...p.results, rerank_1: done("rerank_1", "rr2") }} />)
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
  })

  it("new lists fade in when they first appear, and not again on collapse or expand", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(rows("search").length).toBe(6))
    expect(rows("reranked").every((r) => r.hasAttribute("data-enter"))).toBe(true)
    expect(rows("search").every((r) => r.hasAttribute("data-enter"))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    fireEvent.click(screen.getByRole("button", { name: "Show comparison" }))
    await screen.findByRole("heading", { name: "Search order, 6 candidates" })
    expect(rows("search").some((r) => r.hasAttribute("data-enter"))).toBe(false)
    expect(rows("reranked").some((r) => r.hasAttribute("data-enter"))).toBe(false)
  })

  it("remembers what it showed across a remount, as Back to Ask does", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    render(<Panel {...p} />)
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(rows("search").length).toBe(6))
    cleanup()
    render(<Panel {...p} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(rows("search").length).toBe(6))
    expect(play).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-enter]")).toBeNull()
  })

  it("plays once per distinct rerank result: X, then Y, then X again plays twice", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    const mmr = setReranker(p.graph, LIVE, "mmr")
    rerender(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    await screen.findByRole("heading", { name: "After rerank, MMR, 5 kept" })
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    rerender(<Panel {...p} />)
    await screen.findByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(play).toHaveBeenCalledTimes(2)
  })

  it("reads the slide's duration in its own unit: the built CSS says .32s", () => {
    const style = (dur: string) =>
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        getPropertyValue: (name: string) => (name === "--dur-slow" ? dur : " cubic-bezier(0.2, 0, 0, 1)"),
      } as CSSStyleDeclaration)
    style(".32s")
    expect(slideTiming()).toEqual({ duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" })
    style("320ms")
    expect(slideTiming().duration).toBe(320)
    style("")
    expect(slideTiming().duration).toBe(320)
    vi.restoreAllMocks()
  })
})

describe("the note under a reranker that only reorders", () => {
  it("says the scores are the search's when the reranker kept them", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const mmr = setReranker(p.graph, LIVE, "mmr")
    render(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    const note = await screen.findByText("Ordered by MMR; the scores are the search's.")
    expect((document.querySelector('[data-column="reranked"]') as HTMLElement).contains(note)).toBe(true)
    expect(note.className).toContain("text-fg-muted")
  })

  it("says nothing when the reranker wrote its own scores", async () => {
    const p = props(withCrossEncoder(), { ...RERANKED, rerank_1: done("rerank_1", "rrScored") })
    render(<Panel {...p} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(screen.queryByText(/the scores are the search's/)).toBeNull()
  })
})

describe("the results without a reranker", () => {
  it("shows one list in search order", async () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    expect(await screen.findByRole("heading", { name: "Top 5 of 6 candidates, in search order" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Hide comparison" })).toBeNull()
    expect(screen.queryAllByTestId("badge")).toHaveLength(0)
  })

  it("waits for the Search output, so the list never shows six rows and then five", async () => {
    let release: (v: unknown) => void = () => {}
    payloads.outSlow = new Promise((r) => (release = r))
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "outSlow") })} />)
    // The retrieval result has loaded, but the list waits for what the Search use case returns.
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelectorAll("[data-hit-row]")).toHaveLength(0)
    release(searchJson)
    expect(await screen.findByRole("heading", { name: "Top 5 of 6 candidates, in search order" })).toBeTruthy()
    const shown = [...document.querySelectorAll<HTMLElement>("[data-hit-row]")]
    expect(shown).toHaveLength(5)
    expect(shown.every((r) => r.hasAttribute("data-enter"))).toBe(true)
  })

  it("shows nothing before a question has run", () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), {})} />)
    expect(screen.queryByRole("heading", { name: /candidates/ })).toBeNull()
  })
})

describe("a Chat answer", () => {
  it("renders the written answer above the lists", async () => {
    const chat = setUseCase(sampleGraph(LIVE, UPLOAD), LIVE, "chat")
    render(<AskPanel {...props(chat, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "chat1") })} />)
    const list = await screen.findByRole("heading", { name: "Top 6 of 6 candidates, in search order" })
    const answer = await waitFor(() => document.querySelector("[data-chat-inspector]") as HTMLElement)
    expect(answer).toBeTruthy()
    expect(answer.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("a failed Ask step", () => {
  it("shows the step and its error in the panel", async () => {
    render(
      <AskPanel
        {...props(sampleGraph(LIVE, UPLOAD), {
          retrieve: { id: "retrieve", status: "failed", error: "Traceback (most recent call last):\nValueError: the index is empty" },
          use_case: { id: "use_case", status: "skipped" },
        })}
      />,
    )
    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("Retrieve failed")).toBeTruthy()
    expect(within(alert).getByText("ValueError: the index is empty")).toBeTruthy()
  })
})

describe("house style", () => {
  it("has no en or em dash in the results", async () => {
    render(<AskPanel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(document.body.textContent).not.toMatch(new RegExp("[\\u2013\\u2014]"))
  })
})
