import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import parsedDoc from "@/api/fixtures/parsed_doc.json"
import { resetSampleQuestionsCache } from "@/api/samples"
import { outcomeFor, outcomeText } from "@/components/pipeline/outcome"
import { BUILD_SESSION_KEY } from "@/state/buildSession"
import { resetDocumentForTests } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph } from "@/state/graph"
import { GUIDE_STEPS, resetGuideForTests } from "@/state/guide"
import { readCurrentId, readPipelines, resetPipelinesForTests, savePipeline } from "@/state/pipelines"
import { TEST_REGISTRY } from "@/state/testRegistry"

import { Shell } from "./Shell"

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

const PRIMER = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 2048, content_type: "application/pdf" }
const CARD = {
  name: "chunking-primer",
  title: "A primer on chunking",
  blurb: "Three pages of notes on chunking.",
  shows: "Headings.",
  stresses: "chunk",
  pages: 3,
  default: true,
  filename: PRIMER.filename,
  sha: PRIMER.sha,
  question: "Why do chunk boundaries matter?",
}
const QUESTION = "Which factors decide the best chunk size?"
const QUESTIONS = [{ id: "size-factors", question: QUESTION, gold_answer: "Size factors.", tags: [] }]
const STEP_KEY = "rag-playground:guide-step:v1"

let posts: { path: string; body: { through?: string } }[] = []
let calls: string[] = []

beforeEach(() => {
  posts = []
  calls = []
  resetSampleQuestionsCache()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetPipelinesForTests()
  resetGuideForTests()
  window.history.replaceState(null, "", "/build")
  vi.stubGlobal("EventSource", SilentEventSource)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (init?.method === "POST") calls.push(url)
      if (url === "/api/v2/strategies") return ok({ stages: TEST_REGISTRY })
      if (url === "/api/v2/documents") return ok([PRIMER])
      if (url === "/api/samples") return ok([CARD])
      if (url === "/api/samples/chunking-primer/questions") return ok(QUESTIONS)
      if (url === "/api/v2/runs" && init?.method === "POST") {
        posts.push({ path: url, body: JSON.parse(String(init.body)) })
        return ok({ run_id: "r1" }, 202)
      }
      if (url === "/api/v2/results/a-parse") return ok({})
      if (url === "/api/v2/results/a-parse/payload") return ok(parsedDoc)
      if (url === "/api/v2/results/a-parse-gone") return ok({})
      if (url === "/api/v2/results/a-parse-gone/payload") return ok({ detail: "gone" }, 500)
      if (url === "/api/v2/explain") return ok({ settings: "s", tradeoff: null, warning: null, blocking: false })
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement
const coach = () => screen.getByRole("complementary", { name: "Guided run" })

async function open(step?: number, session?: unknown) {
  if (step !== undefined) window.sessionStorage.setItem(STEP_KEY, String(step))
  if (session) window.sessionStorage.setItem(BUILD_SESSION_KEY, JSON.stringify(session))
  render(<Shell />)
  await waitFor(() => expect(card("parse")).toBeTruthy())
}

const invite = () => screen.queryByRole("region", { name: "Guided run invitation" })
const stored = () => readStoredGraph(TEST_REGISTRY)!
const node = (stage: string) => stored().nodes.find((n) => n.stage === stage)!

describe("the guided run on Build", () => {
  it("offers the invite when nothing has run, and Hide removes it for good", async () => {
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "I know RAG, hide this" }))
    expect(invite()).toBeNull()
    cleanup()
    resetGuideForTests()
    await open()
    await waitFor(() => expect(screen.getByText("Pick a step")).toBeTruthy())
    expect(invite()).toBeNull()
  })

  it("Start puts the primer and the size-factors question in the graph and shows step 1 of 7", async () => {
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    await waitFor(() => expect(coach()).toBeTruthy())
    expect(within(coach()).getByText(/step 1 of 7/)).toBeTruthy()
    expect(node("source").config.sha).toBe(PRIMER.sha)
    expect(node("query").config.text).toBe(QUESTION)
    expect(window.sessionStorage.getItem(STEP_KEY)).toBe("0")
    expect(invite()).toBeNull()
  })

  it("fills the pages and the chunk size from the real graph and sample", async () => {
    await open(0)
    expect(within(coach()).getByText(/This document has 3 pages/)).toBeTruthy()
    cleanup()
    window.sessionStorage.setItem(STEP_KEY, "3")
    resetGuideForTests()
    await open()
    expect(within(coach()).getByText(new RegExp(`at most ${String(node("chunk").config.chunk_size)} characters`))).toBeTruthy()
  })

  it("warns before replacing unsaved work, and Cancel keeps the graph", async () => {
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    fireEvent.change(within(card("chunk")).getByLabelText("Chunk Size"), { target: { value: "123" } })
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    expect(screen.getByText(/This replaces the pipeline you are working on/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText(/This replaces the pipeline you are working on/)).toBeNull()
    expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull()
    expect(node("chunk").config.chunk_size).toBe(123)
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(coach()).toBeTruthy())
    expect(node("chunk").config.chunk_size).not.toBe(123)
  })

  it("Run on step 2 sends the run through the parse node", async () => {
    await open(1)
    fireEvent.click(within(coach()).getByRole("button", { name: "Run Parse" }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.through).toBe(node("parse").id)
  })

  it("Run on step 5 sends the run through the index node", async () => {
    await open(4)
    fireEvent.click(within(coach()).getByRole("button", { name: "Run Index" }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.through).toBe(node("index").id)
  })

  it("marks the current card and dims the later ones", async () => {
    await open(1)
    expect(card("parse").getAttribute("aria-current")).toBe("step")
    expect(card("index").className).toContain("opacity-50")
    expect(card("source").className).not.toContain("opacity-50")
  })

  it("Leave removes the coach, keeps the pipeline and clears the stored step", async () => {
    await open(1)
    fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
    expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull()
    expect(window.sessionStorage.getItem(STEP_KEY)).toBeNull()
    expect(card("parse")).toBeTruthy()
  })

  it("a reload reopens on the stored step", async () => {
    await open(2)
    expect(within(coach()).getByText(/step 3 of 7/)).toBeTruthy()
    expect(within(coach()).getByRole("heading", { name: GUIDE_STEPS[2].title })).toBeTruthy()
  })

  it("a failed step shows its error, keeps Run enabled and hides Next", async () => {
    await open(1, {
      tracked: { results: { parse: { id: "parse", status: "failed", error: "Traceback\nBoom happened" } }, history: {} },
      sigs: {},
      transcript: [],
      asked: null,
      comparisonHidden: null,
    })
    await waitFor(() => expect(within(coach()).getByText("Boom happened")).toBeTruthy())
    expect((within(coach()).getByRole("button", { name: "Run Parse" }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
  })

  it("does not mark a step done because a later card ran", async () => {
    await open(1, {
      tracked: { results: { chunk: { id: "chunk", status: "done" } }, history: {} },
      sigs: {},
      transcript: [],
      asked: null,
      comparisonHidden: null,
    })
    expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
  })

  it("shows the card's own result line and Next once the step's own node is done", async () => {
    await open(1, {
      tracked: { results: { parse: { id: "parse", status: "done", artifact_id: "a-parse" } }, history: {} },
      sigs: {},
      transcript: [],
      asked: null,
      comparisonHidden: null,
    })
    const line = outcomeText(outcomeFor("parse", "parsed_doc", parsedDoc)!)
    await waitFor(() => expect(within(coach()).getByText(line)).toBeTruthy())
    fireEvent.click(within(coach()).getByRole("button", { name: "Next step" }))
    expect(within(coach()).getByText(/step 3 of 7/)).toBeTruthy()
    expect(window.sessionStorage.getItem(STEP_KEY)).toBe("2")
  })
  it("Start does not keep the selected saved pipeline, so Save changes cannot overwrite it", async () => {
    const mine = sampleGraph(TEST_REGISTRY, { sha: "ee".repeat(32), filename: "mine.pdf" }, "Mine?")
    savePipeline("Mine", mine)
    storeGraph(mine)
    const before = readPipelines()
    const id = readCurrentId()
    expect(id).toBeTruthy()
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    // Before Start, "Mine" is selected, so the bar offers its Save control.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    await waitFor(() => expect(coach()).toBeTruthy())
    // After Start, "Mine" is no longer selected, so nothing offers to save over it.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(readCurrentId()).not.toBe(id)
    expect(readPipelines()).toEqual(before)
  })

  it("step 1 only loads the document: no run starts, and Next shows", async () => {
    await open(0)
    fireEvent.click(within(coach()).getByRole("button", { name: "Use this document" }))
    await waitFor(() => expect(within(coach()).getByRole("button", { name: "Next step" })).toBeTruthy())
    expect(calls.filter((u) => u === "/api/v2/runs" || u === "/api/v2/ask")).toEqual([])
    expect(within(coach()).getByText(/A primer on chunking/)).toBeTruthy()
  })

  it("the Inspector follows the step", async () => {
    await open(1)
    await waitFor(() => expect(screen.queryByText("Pick a step")).toBeNull())
  })

  it("a step whose card is missing says so instead of doing nothing", async () => {
    const g = sampleGraph(TEST_REGISTRY, { sha: PRIMER.sha, filename: PRIMER.filename }, QUESTION)
    const gone = g.nodes.find((n) => n.stage === "clean")!.id
    const into = g.edges.find((e) => e.dst === gone)!.src
    const out = g.edges.find((e) => e.src === gone)!.dst
    storeGraph({
      ...g,
      nodes: g.nodes.filter((n) => n.id !== gone),
      edges: [...g.edges.filter((e) => e.src !== gone && e.dst !== gone), { src: into, dst: out } as (typeof g.edges)[number]],
    })
    await open(2)
    expect((within(coach()).getByRole("button", { name: "Run Clean" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(coach()).getByText(/no Clean card/)).toBeTruthy()
  })

  it("the last steps tell the visitor how to ask their own question", async () => {
    await open(5)
    expect(within(coach()).getByText(/ask your own question/)).toBeTruthy()
  })

  it("a done step whose result cannot be read shows a line, not an empty status", async () => {
    // A distinct id: loadPayload caches artifacts at module level, so "a-parse" is already loaded.
    await open(1, {
      tracked: { results: { parse: { id: "parse", status: "done", artifact_id: "a-parse-gone" } }, history: {} },
      sigs: {},
      transcript: [],
      asked: null,
      comparisonHidden: null,
    })
    await waitFor(() =>
      expect(within(coach()).getByRole("status").textContent).toContain("The result could not be read. Run this step again."),
    )
  })

  it("on a phone the invite sits above the cards, and only there", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q === "(max-width: 47.99rem)" || q === "(max-width: 63.99rem)", addEventListener: () => {}, removeEventListener: () => {} })),
    )
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    expect(screen.getAllByRole("region", { name: "Guided run invitation" })).toHaveLength(1)
    const scroll = screen.getByTestId("pipeline-scroll")
    expect(within(scroll).getByRole("region", { name: "Guided run invitation" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    await waitFor(() => expect(coach()).toBeTruthy())
  })

  it("on a wide screen the invite is in the Inspector, not above the cards", async () => {
    await open()
    await waitFor(() => expect(invite()).toBeTruthy())
    expect(within(screen.getByTestId("pipeline-scroll")).queryByRole("region", { name: "Guided run invitation" })).toBeNull()
    expect(within(screen.getByRole("region", { name: "Inspector" })).getByRole("region", { name: "Guided run invitation" })).toBeTruthy()
  })

  it("the guided run replaces the Ask dock, and Leave brings it back as it was", async () => {
    const dockState = JSON.stringify({ open: true, side: "right", width: 500 })
    window.localStorage.setItem("rag-playground:ask-dock:v1", dockState)
    await open()
    const main = document.querySelector("main")!
    const aside = () => document.getElementById("ask-dock") as HTMLElement
    await waitFor(() => expect(invite()).toBeTruthy())
    expect(aside().hidden).toBe(false)
    expect(main.className).toContain("lg:grid-cols-[380px_minmax(0,1fr)_minmax(320px")
    fireEvent.click(screen.getByRole("button", { name: "Start the guided run" }))
    await waitFor(() => expect(coach()).toBeTruthy())
    expect(aside().hidden).toBe(true)
    expect((document.querySelector(".ask-fab") as HTMLElement).hidden).toBe(true)
    expect(main.className).not.toContain("lg:grid-cols-")
    expect(main.className).toContain("xl:grid-cols-[380px_minmax(0,1fr)_340px]")
    fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
    expect(aside().hidden).toBe(false)
    expect(main.className).toContain("lg:grid-cols-[380px_minmax(0,1fr)_minmax(320px")
    expect(window.localStorage.getItem("rag-playground:ask-dock:v1")).toBe(dockState)
  })
})
