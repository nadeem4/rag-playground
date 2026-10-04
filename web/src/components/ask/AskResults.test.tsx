import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchJson from "@/api/fixtures/output.search.json"
import chatJson from "@/api/fixtures/output.chat.json"
import type { Keys } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry, RetrievalResult } from "@/api/types"
import { sampleGraph, setReranker, setRewrite, setUseCase, type PipelineGraph } from "@/state/graph"

import { AskPanel, type AskPanelProps } from "./AskPanel"
import { resetMotionMemory } from "./AskResults"

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
    onRewrite: vi.fn(),
    onAsk: vi.fn(),
  }
}

const withCrossEncoder = () => setReranker(sampleGraph(LIVE, UPLOAD), LIVE, "cross_encoder")
const RERANKED = { retrieve: done("retrieve", "ret1"), rerank_1: done("rerank_1", "rr1"), use_case: done("use_case", "out1") }
/** The reranked column's finding lines, Not kept slips included. */
const findings = () => [...document.querySelectorAll('[data-column="reranked"] [data-testid=finding]')].map((b) => b.textContent ?? "")
/** The kept pieces' finding lines: where each moved from. */
const badges = () => findings().filter((t) => !t.startsWith("Not kept"))
const NOTE = "Scored 6 candidates with MiniLM in 0.2 s. 4 of the top 5 changed place."

/** The panel with the comparison state held above it, as Shell holds it. */
function Panel(p: AskPanelProps) {
  const [hidden, setHidden] = useState<string | null>(null)
  return <AskPanel {...p} comparisonHidden={hidden} onComparison={setHidden} />
}

describe("the comparison, with a reranker", () => {
  it("shows the search order against the reranked order, with finding lines from prior_rank", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    expect(await screen.findByRole("heading", { name: "Search order against the reranked order" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Hide comparison" })).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Search order, 6 candidates" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })).toBeTruthy()
    await waitFor(() =>
      expect(badges()).toEqual([
        "1st, moved up from 6th",
        "2nd, moved down from 1st",
        "3rd, moved down from 2nd",
        "4th, stayed in place",
        "5th, moved down from 3rd",
      ]),
    )
    // The rank 1 hit came from rank 6.
    const top = document.querySelector('[data-column="reranked"] [data-hit-row="1"]') as HTMLElement
    const finding = within(top).getByTestId("finding")
    expect(finding.className).toContain("font-sans")
    expect(finding.className).not.toContain("font-mono")
    expect(within(finding).getByText("moved up from 6th").className).toContain("font-semibold")
    // The left column says each piece's place in search; the kept highlight is the finding line and nothing else.
    const left = document.querySelector('[data-column="search"]') as HTMLElement
    expect(within(left).getAllByTestId("finding").map((f) => f.textContent!.split(",")[0])).toEqual([
      "1st in search",
      "2nd in search",
      "3rd in search",
      "4th in search",
      "5th in search",
      "6th in search",
    ])
    expect(left.textContent).not.toMatch(/kept/i)
    expect(await screen.findByText("Scored 6 candidates with MiniLM in 0.2 s. 4 of the top 5 changed place.")).toBeTruthy()
  })

  it("states the movement count once, in the run note as the sub line", async () => {
    // An id of its own: the meta cache outlives a test, and this one counts the fetches.
    payloads.rrOnce = reranked()
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === "/api/artifacts/rrOnce" ? new Response(JSON.stringify({ id: "rrOnce", meta: { note: NOTE } }), { status: 200 }) : base(url),
    )
    render(<Panel {...props(withCrossEncoder(), { ...RERANKED, rerank_1: done("rerank_1", "rrOnce") })} />)
    const note = await screen.findByText(NOTE)
    expect(note.dataset.testid).toBe("sub-line")
    expect(note.className).toContain("text-xs")
    expect(note.className).toContain("text-fg-muted")
    expect(screen.getAllByText(NOTE)).toHaveLength(1)
    expect((document.querySelector('[data-column="reranked"]') as HTMLElement).contains(note)).toBe(false)
    expect(screen.queryByTestId("fact-moved")).toBeNull()
    expect(document.body.textContent).not.toMatch(/Moved \d+ of/)
    // The note was fetched once.
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => u === "/api/artifacts/rrOnce")).toHaveLength(1)
  })

  it("holds the sub line's place while the run note loads, so it does not push the lists down late", async () => {
    let release: (r: Response) => void = () => {}
    payloads.rrLate = reranked()
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url) => (url === "/api/artifacts/rrLate" ? new Promise<Response>((r) => (release = r)) : base(url)))
    render(<Panel {...props(withCrossEncoder(), { ...RERANKED, rerank_1: done("rerank_1", "rrLate") })} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    const sub = screen.getByTestId("sub-line")
    expect(sub.textContent).toBe("")
    expect(sub.className).toContain("min-h-[1lh]")
    release(new Response(JSON.stringify({ id: "rrLate", meta: { note: NOTE } }), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId("sub-line").textContent).toBe(NOTE))
  })

  it("has no sub line under a reranker without a run note; the column says what it did", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const mmr = setReranker(p.graph, LIVE, "mmr")
    render(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    await screen.findByRole("heading", { name: "After rerank, MMR, 5 kept" })
    await waitFor(() => expect(document.querySelector('[data-column="reranked"] [data-testid=what-it-did]')).toBeTruthy())
    expect(screen.queryByTestId("sub-line")).toBeNull()
  })

  it("puts the piece the reranker dropped under the kept ones, as a Not kept slip, on the reranked column only", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(findings()).toHaveLength(6))
    expect(findings()[5]).toBe("Not kept. It was 5th in search, but Cross-encoder ranked others higher.")
    const right = [...document.querySelectorAll<HTMLElement>('[data-column="reranked"] [data-slip]')]
    expect(right[5].dataset.flipKey).toBe(hybrid.hits[4].chunk.id)
    expect(right[5].className).toContain("opacity-75")
    const left = document.querySelector('[data-column="search"]') as HTMLElement
    expect(left.textContent).not.toMatch(/Not kept/)
    // Collapsed, the right list still ends with it.
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    expect(findings()[5]).toBe("Not kept. It was 5th in search, but Cross-encoder ranked others higher.")
  })

  it("sets the lists flat on the page: no boxed frame and no tinted header strip (spec section 2)", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(findings()).toHaveLength(6))
    const results = screen.getByRole("region", { name: "Results" })
    expect(results.querySelector(".rounded-panel.border")).toBeNull()
    expect(results.querySelector(".bg-surface-elevated")).toBeNull()
    // The column titles stay, as plain lines.
    expect(screen.getByRole("heading", { name: "Search order, 6 candidates" })).toBeTruthy()
  })

  it("collapsing hides the search order and keeps the reranked list with its finding lines", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    fireEvent.click(await screen.findByRole("button", { name: "Hide comparison" }))
    expect(screen.queryByRole("heading", { name: "Search order, 6 candidates" })).toBeNull()
    expect(document.querySelector('[data-column="search"]')).toBeNull()
    expect(screen.getByRole("button", { name: "Show comparison" })).toBeTruthy()
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(badges()[0]).toBe("1st, moved up from 6th")
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

describe("the slope between the two lists", () => {
  it("draws one line per kept piece, from its search swatch to its reranked swatch, by movement", async () => {
    // Each swatch sits at its place in its column, so the lines have coordinates.
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const column = this.closest("[data-column]")?.getAttribute("data-column")
      const el = this as HTMLElement
      if (el.hasAttribute("data-gutter")) return new DOMRect(400, 0, 96, 800)
      if (!column || el.dataset.id === undefined) return new DOMRect(0, 0, 0, 0)
      const i = [...this.closest("[data-column]")!.querySelectorAll("[data-id]")].indexOf(this)
      return new DOMRect(column === "search" ? 0 : 600, 40 + i * 60, 30, 30)
    })
    onTestFinished(() => spy.mockRestore())
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    const svg = document.querySelector("svg.slope-lines") as SVGElement
    expect(svg).toBeTruthy()
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    // Each list is as tall as its own slips, so opening a passage resizes it and the lines follow.
    expect(document.querySelector("[data-slope-grid]")!.className).toContain("items-start")
    // A 96 px gutter between the two lists.
    expect(document.querySelector("[data-slope-grid]")!.className).toContain("grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)]")
    // Prior ranks 6, 1, 2, 4, 3: up, down, down, stayed, down. The dropped piece has no line.
    const ids = [5, 0, 1, 3, 2].map((i) => hybrid.hits[i].chunk.id)
    await waitFor(() => expect(svg.querySelectorAll("path")).toHaveLength(5))
    const paths = [...svg.querySelectorAll("path")]
    expect(paths.map((p) => p.getAttribute("data-id"))).toEqual(ids)
    expect(paths.map((p) => p.getAttribute("data-kind"))).toEqual(["up", "down", "down", "same", "down"])
    // The top kept piece was 6th in search: across the gutter (x 400 to 496), from the 6th left swatch's
    // centre (y 340 + 15) to the 1st right one's (y 40 + 15). No line reaches into either column.
    expect(paths[0].getAttribute("d")).toBe("M 402,355 C 442,355 454,55 494,55")
  })

  it("draws no lines while the comparison is hidden", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(document.querySelector("svg.slope-lines")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    expect(document.querySelector("svg.slope-lines")).toBeNull()
  })
})

describe("compact slips in the comparison", () => {
  const passages = (column: string) => [...document.querySelectorAll<HTMLElement>(`[data-column="${column}"] [data-testid=passage]`)]

  it("clamps the passage to two lines on both sides, so the two lists keep the same rhythm", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(passages("search")).toHaveLength(6)
    expect(passages("reranked")).toHaveLength(6)
    expect([...passages("search"), ...passages("reranked")].every((p) => p.className.includes("line-clamp-2"))).toBe(true)
  })

  it("Show more opens one passage in place and Show less closes it", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    const top = document.querySelector<HTMLElement>('[data-column="reranked"] [data-hit-row="1"]')!
    fireEvent.click(within(top).getByRole("button", { name: "Show more" }))
    expect(within(top).getByTestId("passage").className).not.toContain("line-clamp")
    expect(passages("reranked").filter((p) => p.className.includes("line-clamp-2"))).toHaveLength(5)
    fireEvent.click(within(top).getByRole("button", { name: "Show less" }))
    expect(within(top).getByTestId("passage").className).toContain("line-clamp-2")
  })

  it("both sides share one slip anatomy: a place line, two lines of passage, one meta line with one score", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    const slip = (column: string) => document.querySelector<HTMLElement>(`[data-column="${column}"] [data-hit-row="1"]`)!
    const anatomy = (el: HTMLElement) => ({
      parts: [...el.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid")),
      scores: el.querySelectorAll("[data-score]").length,
      buttons: within(el)
        .getAllByRole("button")
        .map((b) => b.textContent),
    })
    expect(anatomy(slip("search"))).toEqual(anatomy(slip("reranked")))
    expect(anatomy(slip("search")).scores).toBe(1)
    // The search side's score moves from the place line to the meta line.
    expect(within(slip("search")).getByTestId("finding").textContent).toBe("1st in search")
    expect(slip("search").querySelector("[data-score]")!.textContent).toMatch(/^RRF /)
  })

  it("the single list keeps its full passages", async () => {
    render(<Panel {...props(sampleGraph(LIVE, UPLOAD), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    await waitFor(() => expect(document.querySelectorAll("[data-testid=passage]").length).toBeGreaterThan(0))
    expect([...document.querySelectorAll("[data-testid=passage]")].some((p) => p.className.includes("line-clamp"))).toBe(false)
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull()
  })
})

describe("the linked highlight", () => {
  it("shows no hand cursor on a slip in the wide layout, where a click does nothing", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(slipOf("reranked", top()).className).not.toContain("cursor-pointer")
    expect(document.querySelector("[data-slope-grid]")!.className).not.toContain("cursor-pointer")
  })

  const slipOf = (column: string, id: string) => document.querySelector(`[data-column="${column}"] [data-id="${id}"]`)!.closest<HTMLElement>("[data-slip]")!
  const litSlips = () => [...document.querySelectorAll<HTMLElement>("[data-slip][data-lit]")]
  const path = (id: string) => document.querySelector<SVGPathElement>(`svg.slope-lines path[data-id="${id}"]`)!
  const svg = () => document.querySelector<SVGElement>("svg.slope-lines")!
  const ready = async () => {
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(5))
  }
  /** The top reranked piece: 6th in search. */
  const top = () => hybrid.hits[5].chunk.id
  /** The highlight's grace before it clears. */
  const grace = (ms = 80) => act(() => vi.advanceTimersByTime(ms))

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it("a new rerank result starts with nothing lit", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    await ready()
    fireEvent.mouseOver(slipOf("search", top()))
    expect(litSlips()).toHaveLength(2)
    rerender(<Panel {...p} results={{ ...p.results, rerank_1: done("rerank_1", "rr2") }} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(litSlips()).toHaveLength(0)
  })

  it("hovering a left slip lights its right twin and its line, and dims the other lines; leaving clears it", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await ready()
    fireEvent.mouseOver(slipOf("search", top()))
    expect(litSlips()).toEqual([slipOf("search", top()), slipOf("reranked", top())])
    expect(path(top()).classList.contains("lit")).toBe(true)
    expect(svg().hasAttribute("data-active")).toBe(true)
    expect(document.querySelectorAll("svg.slope-lines path.lit")).toHaveLength(1)
    fireEvent.mouseLeave(document.querySelector("[data-slope-grid]")!)
    grace()
    expect(litSlips()).toEqual([])
    expect(document.querySelectorAll("svg.slope-lines path.lit")).toHaveLength(0)
    expect(svg().hasAttribute("data-active")).toBe(false)
  })

  it("crossing the gap to the next slip does not flicker: the highlight holds for 80 ms", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await ready()
    const next = hybrid.hits[0].chunk.id
    fireEvent.mouseOver(slipOf("reranked", top()))
    expect(litSlips()).toHaveLength(2)
    // The 4 px gap: still lit, then the next slip takes over with no dark frame.
    fireEvent.mouseOver(document.querySelector('[data-column="reranked"]')!)
    grace(79)
    expect(litSlips()).toEqual([slipOf("search", top()), slipOf("reranked", top())])
    fireEvent.mouseOver(slipOf("reranked", next))
    grace(200)
    expect(litSlips()).toEqual([slipOf("search", next), slipOf("reranked", next)])
  })

  it("resting on the gap clears it after the grace", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await ready()
    fireEvent.mouseOver(slipOf("reranked", top()))
    fireEvent.mouseOver(document.querySelector('[data-column="reranked"]')!)
    grace()
    expect(litSlips()).toEqual([])
  })

  it("focus lights the same way, and blur clears it", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await ready()
    const id = hybrid.hits[0].chunk.id
    fireEvent.focus(slipOf("reranked", id))
    expect(litSlips()).toEqual([slipOf("search", id), slipOf("reranked", id)])
    expect(path(id).classList.contains("lit")).toBe(true)
    fireEvent.blur(slipOf("reranked", id))
    grace()
    expect(litSlips()).toEqual([])
  })

  it("a slip without a twin lights only itself, and no line", async () => {
    // The reranker's top piece is one the search list does not show.
    const lonely = reranked()
    lonely.hits[0] = { ...lonely.hits[0], chunk: { ...lonely.hits[0].chunk, id: "lonely" } }
    payloads.rrLonely = lonely
    render(<Panel {...props(withCrossEncoder(), { ...RERANKED, rerank_1: done("rerank_1", "rrLonely") })} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(4))
    fireEvent.mouseOver(slipOf("reranked", "lonely"))
    expect(litSlips()).toEqual([slipOf("reranked", "lonely")])
    expect(document.querySelectorAll("svg.slope-lines path.lit")).toHaveLength(0)
    expect(svg().hasAttribute("data-active")).toBe(false)
  })
})

describe("below the wide layout (phone and tablet)", () => {
  /** A window narrower than 1280 px: the min-width query fails, reduced motion is off. */
  const narrow = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const slipOf = (column: string, id: string) => document.querySelector(`[data-column="${column}"] [data-id="${id}"]`)!.closest<HTMLElement>("[data-slip]")!
  const top = () => hybrid.hits[5].chunk.id
  let scrolled: ReturnType<typeof vi.fn>

  beforeEach(() => {
    narrow()
    scrolled = vi.fn()
    Object.assign(Element.prototype, { scrollIntoView: scrolled })
  })
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it("shows the reranked list first, draws no lines, and folds the search order under a closed disclosure", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(document.querySelector("svg.slope-lines")).toBeNull()
    expect(document.querySelector('[data-column="search"]')).toBeNull()
    const disclosure = screen.getByRole("button", { name: "Show search order" })
    expect(disclosure.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(disclosure)
    const search = document.querySelector('[data-column="search"]')!
    expect(search).toBeTruthy()
    expect(screen.getByRole("button", { name: "Hide search order" }).getAttribute("aria-expanded")).toBe("true")
    // The reranked list comes first.
    const reranked = document.querySelector('[data-column="reranked"]')!
    expect(reranked.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("a tap lights a slip and its twin and brings the twin into view; a second tap clears it; hover does nothing", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    fireEvent.click(screen.getByRole("button", { name: "Show search order" }))
    fireEvent.mouseOver(slipOf("reranked", top()))
    expect(document.querySelectorAll("[data-slip][data-lit]")).toHaveLength(0)
    fireEvent.click(slipOf("reranked", top()))
    expect([...document.querySelectorAll("[data-slip][data-lit]")]).toEqual([slipOf("reranked", top()), slipOf("search", top())])
    // A smooth scroll that centres the twin, so the reader keeps their place.
    expect(scrolled).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
    expect(scrolled.mock.contexts[0]).toBe(slipOf("search", top()))
    fireEvent.click(slipOf("reranked", top()))
    expect(document.querySelectorAll("[data-slip][data-lit]")).toHaveLength(0)
    // A list item takes no aria-pressed: data-lit alone carries the state.
    expect(slipOf("reranked", top()).hasAttribute("aria-pressed")).toBe(false)
  })

  it("a tap does not also select the slip: after two taps it has neither the lit nor the selected look", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    const slip = slipOf("reranked", top())
    fireEvent.click(slip)
    fireEvent.click(slip)
    expect(slip.hasAttribute("data-lit")).toBe(false)
    expect(slip.className).not.toContain("bg-selection")
    fireEvent.keyDown(slip, { key: "Enter" })
    fireEvent.keyDown(slip, { key: "Enter" })
    expect(slip.className).not.toContain("bg-selection")
  })

  it("shows the hand cursor on a slip only where a tap does something", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    expect(document.querySelector("[data-slope-grid]")!.className).toContain("[&_[data-slip]]:cursor-pointer")
    expect(slipOf("reranked", top()).className).not.toContain("cursor-pointer")
  })

  it("scrolls to the twin without motion under reduced motion", async () => {
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q.includes("reduced-motion"), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    fireEvent.click(screen.getByRole("button", { name: "Show search order" }))
    fireEvent.click(slipOf("reranked", top()))
    expect(scrolled).toHaveBeenCalledWith({ behavior: "auto", block: "center" })
  })

  it("the search order starts closed on every switch between the wide and the stacked layout", async () => {
    let isWide = false
    const listeners = new Set<() => void>()
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({
        matches: q.includes("min-width") ? isWide : false,
        addEventListener: (_: string, f: () => void) => listeners.add(f),
        removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      })),
    )
    const flip = (w: boolean) =>
      act(() => {
        isWide = w
        listeners.forEach((f) => f())
      })
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    fireEvent.click(screen.getByRole("button", { name: "Show search order" }))
    expect(screen.getByRole("button", { name: "Hide search order" })).toBeTruthy()
    flip(true)
    expect(document.querySelector("[data-gutter]")).toBeTruthy()
    flip(false)
    expect(screen.getByRole("button", { name: "Show search order" }).getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-column="search"]')).toBeNull()
  })

  it("Show more does not toggle the highlight", async () => {
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    fireEvent.click(within(slipOf("reranked", top())).getByRole("button", { name: "Show more" }))
    expect(slipOf("reranked", top()).hasAttribute("data-lit")).toBe(false)
  })
})

describe("the two result motions", () => {
  const rows = (column: string) => [...document.querySelectorAll<HTMLElement>(`[data-column="${column}"] [data-hit-row]`)]
  /** The lines the draw has animated so far, by data-id, in call order. */
  let animate: ReturnType<typeof vi.fn>
  const drawn = () => animate.mock.contexts.map((el) => (el as Element).getAttribute("data-id"))

  beforeEach(() => {
    animate = vi.fn()
    // jsdom has no Web Animations API and no SVG geometry.
    Object.assign(Element.prototype, { animate, getTotalLength: () => 100 })
  })

  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate
    delete (Element.prototype as { getTotalLength?: unknown }).getTotalLength
  })

  it("draws the lines once per rerank result, never on a rerender, a collapse or an expand", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(5))
    expect(drawn()).toEqual([5, 0, 1, 3, 2].map((i) => hybrid.hits[i].chunk.id))
    expect(animate.mock.calls[0]).toEqual([
      [
        { strokeDasharray: "100", strokeDashoffset: 100 },
        { strokeDasharray: "100", strokeDashoffset: 0 },
      ],
      { duration: 360, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    ])
    rerender(<Panel {...p} />)
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    fireEvent.click(screen.getByRole("button", { name: "Show comparison" }))
    await screen.findByRole("heading", { name: "Search order, 6 candidates" })
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(5))
    expect(animate).toHaveBeenCalledTimes(5)
    // A new rerank result draws once more.
    rerender(<Panel {...p} results={{ ...p.results, rerank_1: done("rerank_1", "rr2") }} />)
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(10))
  })

  it("draws nothing under reduced motion: the lines are there at full length", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    render(<Panel {...props(withCrossEncoder(), RERANKED)} />)
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(5))
    expect(animate).not.toHaveBeenCalled()
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
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(5))
    await waitFor(() => expect(rows("search").length).toBe(6))
    cleanup()
    render(<Panel {...p} />)
    await waitFor(() => expect(badges()).toHaveLength(5))
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(5))
    expect(animate).toHaveBeenCalledTimes(5)
    expect(document.querySelector("[data-enter]")).toBeNull()
  })

  it("draws once per distinct rerank result: X, then Y, then X again draws nothing new", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const { rerender } = render(<Panel {...p} />)
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(5))
    const mmr = setReranker(p.graph, LIVE, "mmr")
    rerender(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    await screen.findByRole("heading", { name: "After rerank, MMR, 5 kept" })
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(10))
    rerender(<Panel {...p} />)
    await screen.findByRole("heading", { name: "After rerank, Cross-encoder, 5 kept" })
    await waitFor(() => expect(document.querySelectorAll("svg.slope-lines path")).toHaveLength(5))
    expect(animate).toHaveBeenCalledTimes(10)
  })
})

describe("the note under a reranker that only reorders", () => {
  it("says the scores are the search's when the reranker kept them", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const mmr = setReranker(p.graph, LIVE, "mmr")
    render(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    const note = await screen.findByText("Ordered by MMR; the scores are the search's.")
    expect(note.className).toContain("text-fg-muted")
    // Above the two lists, not inside the right one, so both lists start level.
    expect(note.closest("[data-column]")).toBeNull()
    const grid = document.querySelector("[data-slope-grid]")!
    expect(note.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps the note with the right list when the comparison is hidden", async () => {
    const p = props(withCrossEncoder(), RERANKED)
    const mmr = setReranker(p.graph, LIVE, "mmr")
    render(<Panel {...p} graph={mmr} results={{ ...p.results, rerank_1: done("rerank_1", "rr3") }} />)
    await screen.findByText("Ordered by MMR; the scores are the search's.")
    fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }))
    const note = screen.getByText("Ordered by MMR; the scores are the search's.")
    expect((document.querySelector('[data-column="reranked"]') as HTMLElement).contains(note)).toBe(true)
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
    expect((await screen.findByTestId("sub-line")).textContent).toBe("Hybrid search returned 6 candidates. These are the top 5, in search order.")
    // The sub line says it, so no heading repeats it.
    expect(screen.queryByRole("heading", { name: /candidates, in search order/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Hide comparison" })).toBeNull()
    expect(screen.getAllByTestId("finding").map((f) => f.textContent!.split(",")[0])).toEqual(["1st", "2nd", "3rd", "4th", "5th"])
    expect(document.body.textContent).not.toMatch(/Not kept/)
  })

  it("says how many candidates the search returned and how many are shown, in the sub line", async () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    const sub = await screen.findByTestId("sub-line")
    expect(sub.textContent).toBe("Hybrid search returned 6 candidates. These are the top 5, in search order.")
    expect(sub.className).toContain("text-xs")
    expect(sub.className).toContain("text-fg-muted")
  })

  it("names the retriever in the sub line", async () => {
    const g = sampleGraph(LIVE, UPLOAD)
    const bm25: PipelineGraph = { ...g, nodes: g.nodes.map((n) => (n.stage === "retrieve" ? { ...n, transform: "bm25" } : n)) }
    render(<AskPanel {...props(bm25, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    expect((await screen.findByTestId("sub-line")).textContent).toBe("BM25 search returned 6 candidates. These are the top 5, in search order.")
  })

  it("waits for the Search output, so the list never shows six rows and then five", async () => {
    let release: (v: unknown) => void = () => {}
    payloads.outSlow = new Promise((r) => (release = r))
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "outSlow") })} />)
    // The retrieval result has loaded, but the list waits for what the Search use case returns.
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelectorAll("[data-hit-row]")).toHaveLength(0)
    release(searchJson)
    expect((await screen.findByTestId("sub-line")).textContent).toBe("Hybrid search returned 6 candidates. These are the top 5, in search order.")
    const shown = [...document.querySelectorAll<HTMLElement>("[data-hit-row]")]
    expect(shown).toHaveLength(5)
    expect(shown.every((r) => r.hasAttribute("data-enter"))).toBe(true)
  })

  it("shows nothing before a question has run", () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD), {})} />)
    expect(screen.queryByRole("heading", { name: /candidates/ })).toBeNull()
    expect(screen.queryByTestId("sub-line")).toBeNull()
  })
})

describe("the finding sentence", () => {
  const SEARCH_ONLY = { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") }
  const collapse = (t: string) => t.replace(/\s+/g, " ")

  it("says what the closest piece says, verbatim, for a question outside the sample set", async () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD, "Who wrote this?"), SEARCH_ONLY)} />)
    const p = await screen.findByTestId("finding-sentence")
    const top = (searchJson as { payload: { results: { snippet: string }[] } }).payload.results[0].snippet
    const said = (p.querySelector(".font-serif") as HTMLElement).textContent!
    expect(top.startsWith(said)).toBe(true)
    // The snippet opens with a heading line: the line ends the sentence.
    expect(said).toBe("Overlap and its cost")
    expect(collapse(p.textContent!)).toBe(`The closest piece says: ${collapse(said)}`)
    // It sits above the sub line and the list.
    const sub = screen.getByTestId("sub-line")
    expect(p.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("names the kept piece that holds the gold answer of a sample's question", async () => {
    const card = { name: "primer", title: "t", blurb: "b", shows: "s", stresses: "chunk", pages: 3, default: false, filename: UPLOAD.filename, sha: UPLOAD.sha, question: "q" }
    const golds = [{ id: "q1", question: "What should I measure?", gold_answer: "compare strategies on the same parsed document" }]
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/samples") return ok([card])
      if (url === "/api/samples/primer/questions") return ok(golds)
      return base(url)
    })
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD, "What should I measure?"), SEARCH_ONLY)} />)
    await waitFor(() => expect(screen.getByTestId("finding-sentence").textContent).toBe("Found in the 3rd piece: compare strategies on the same parsed document"))
    const q = screen.getByTestId("finding-sentence").querySelector("q") as HTMLElement
    expect(q.className).toContain("font-serif")
    expect(q.className).toContain("italic")
  })

  it("reads the kept pieces in reranked order under a reranker", async () => {
    render(<Panel {...props(setReranker(sampleGraph(LIVE, UPLOAD, "Who wrote this?"), LIVE, "cross_encoder"), RERANKED)} />)
    const p = await screen.findByTestId("finding-sentence")
    // The reranked top piece is the search's sixth.
    expect(hybrid.hits[5].chunk.text.startsWith((p.querySelector(".font-serif") as HTMLElement).textContent!)).toBe(true)
  })

  it("is not shown with Chat: the written answer stands in", async () => {
    const chat = setUseCase(sampleGraph(LIVE, UPLOAD), LIVE, "chat")
    render(<AskPanel {...props(chat, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "chat1") })} />)
    await waitFor(() => expect(document.querySelector("[data-chat-inspector]")).toBeTruthy())
    expect(screen.queryByTestId("finding-sentence")).toBeNull()
  })
})

describe("the Searched for line", () => {
  const QUESTION = "Who is my current employer?"
  const REWRITE = "current employer company present role"

  it("is absent without a rewrite", async () => {
    render(<AskPanel {...props(sampleGraph(LIVE, UPLOAD, QUESTION), { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    await screen.findByTestId("finding-sentence")
    expect(screen.queryByTestId("searched-for")).toBeNull()
  })

  it("shows PRF's expanded query, with the added terms in the data face", async () => {
    payloads.retPrf = { ...hybrid, expanded_query: `${QUESTION} present experience`, expansion_terms: ["present", "experience"] }
    const g = setRewrite(sampleGraph(LIVE, UPLOAD, QUESTION), LIVE, "prf")
    render(<AskPanel {...props(g, { retrieve: done("retrieve", "retPrf"), use_case: done("use_case", "out1") })} />)
    const line = await screen.findByTestId("searched-for")
    expect(line.textContent).toBe(`Searched for: ${QUESTION} present experience`)
    const terms = within(line).getByText("present experience")
    expect(terms.className).toContain("font-mono")
    expect(screen.queryByText(/^Asked:/)).toBeNull()
  })

  it("shows the model's rewrite and the question as asked", async () => {
    payloads.q1 = { text: REWRITE, original: QUESTION }
    const g = setRewrite(sampleGraph(LIVE, UPLOAD, QUESTION), LIVE, "llm")
    render(<AskPanel {...props(g, { query: done("query", "q1"), retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    const line = await screen.findByTestId("searched-for")
    expect(line.textContent).toBe(`Searched for: ${REWRITE}`)
    expect(screen.getByTestId("asked-as").textContent).toBe(`Asked: ${QUESTION}`)
  })

  it("is absent when the model gave no usable rewrite", async () => {
    payloads.q2 = { text: QUESTION, original: "" }
    const g = setRewrite(sampleGraph(LIVE, UPLOAD, QUESTION), LIVE, "llm")
    render(<AskPanel {...props(g, { query: done("query", "q2"), retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    await screen.findByTestId("finding-sentence")
    expect(screen.queryByTestId("searched-for")).toBeNull()
  })

  it("the finding sentence keeps the question as asked, not the rewrite (Review Focus 1)", async () => {
    const card = { name: "primer", title: "t", blurb: "b", shows: "s", stresses: "chunk", pages: 3, default: false, filename: UPLOAD.filename, sha: UPLOAD.sha, question: "q" }
    const golds = [{ id: "q1", question: "What should I measure?", gold_answer: "compare strategies on the same parsed document" }]
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/samples") return ok([card])
      if (url === "/api/samples/primer/questions") return ok(golds)
      return base(url)
    })
    payloads.q3 = { text: "measure compare strategies", original: "What should I measure?" }
    const g = setRewrite(sampleGraph(LIVE, UPLOAD, "What should I measure?"), LIVE, "llm")
    render(<AskPanel {...props(g, { query: done("query", "q3"), retrieve: done("retrieve", "ret1"), use_case: done("use_case", "out1") })} />)
    await waitFor(() => expect(screen.getByTestId("finding-sentence").textContent).toBe("Found in the 3rd piece: compare strategies on the same parsed document"))
    expect(screen.getByTestId("searched-for").textContent).toBe("Searched for: measure compare strategies")
  })
})

describe("a Chat answer", () => {
  it("renders the written answer above the lists", async () => {
    const chat = setUseCase(sampleGraph(LIVE, UPLOAD), LIVE, "chat")
    render(<AskPanel {...props(chat, { retrieve: done("retrieve", "ret1"), use_case: done("use_case", "chat1") })} />)
    const list = await screen.findByText("Hybrid search returned 6 candidates. These are the top 6, in search order.")
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
