import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import parsedDoc from "@/api/fixtures/parsed_doc.json"
import hybridResult from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchOutput from "@/api/fixtures/output.search.json"
import { resetSampleQuestionsCache } from "@/api/samples"
import { outcomeFor, outcomeText } from "@/components/pipeline/outcome"
import { BUILD_SESSION_KEY } from "@/state/buildSession"
import { chooseDocument, documentOf, resetDocumentForTests } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, signature, storeGraph } from "@/state/graph"
import { GUIDE_FIX, GUIDE_RULE, GUIDE_STEPS, resetGuideForTests } from "@/state/guide"
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
let asks: string[] = []
// What POST /api/v2/golds/find answers, and whether POST /api/v2/ask fails.
let goldAnswer: unknown = { found: null }
let askFails = false
let askFailDetail = "The search service is down."

// Twenty candidates, of which the answer step reads the first five.
const CANDIDATES = {
  ...hybridResult,
  hits: Array.from({ length: 20 }, (_, i) => ({
    ...hybridResult.hits[0],
    rank: i + 1,
    chunk: { ...hybridResult.hits[0].chunk, id: `c${i + 1}`, text: `Piece number ${i + 1} about chunking.` },
  })),
}
const READ_ROWS = { ...searchOutput, payload: { ...searchOutput.payload, results: searchOutput.payload.results.slice(0, 5) } }
const ASKED = {
  tracked: {
    results: {
      retrieve: { id: "retrieve", status: "done", artifact_id: "ret-g" },
      use_case: { id: "use_case", status: "done", artifact_id: "out-g" },
    },
    history: {},
  },
  sigs: {},
  transcript: [],
  asked: null,
  comparisonHidden: null,
}

beforeEach(() => {
  posts = []
  calls = []
  asks = []
  goldAnswer = { found: null }
  askFails = false
  askFailDetail = "The search service is down."
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
      if (url === "/api/v2/ask" && init?.method === "POST") {
        asks.push(String(init.body))
        return askFails ? ok({ detail: askFailDetail }, 500) : ok({ run_id: "r2" }, 202)
      }
      if (url === "/api/v2/golds/find" && init?.method === "POST") return ok(goldAnswer)
      if (url === "/api/v2/results/ret-g") return ok({})
      if (url === "/api/v2/results/ret-g/payload") return ok(CANDIDATES)
      if (url === "/api/v2/results/out-g") return ok({})
      if (url === "/api/v2/results/out-g/payload") return ok(READ_ROWS)
      if (url === "/api/v2/results/ret-a") return ok({})
      if (url === "/api/v2/results/ret-a/payload") return ok(CANDIDATES)
      if (url === "/api/v2/results/out-a") return ok({})
      if (url === "/api/v2/results/out-a/payload") return ok(READ_ROWS)
      // The saved index result exists on the server; an unknown artifact would be dropped as gone after a restart.
      if (url === "/api/v2/results/idx-1") return ok({})
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

  describe("opened by a link", () => {
    const link = (value: string) => window.history.replaceState(null, "", `/build?guide=${value}`)

    it("?guide=chunk starts at step 4, runs the earlier steps once through Clean and drops the param", async () => {
      link("chunk")
      await open()
      await waitFor(() => expect(within(coach()).getByText(/step 4 of 7/)).toBeTruthy())
      expect(node("source").config.sha).toBe(PRIMER.sha)
      expect(node("query").config.text).toBe(QUESTION)
      await waitFor(() => expect(posts).toHaveLength(1))
      expect(posts[0].body.through).toMatch(/^clean/)
      expect(within(coach()).getByText("Getting the earlier steps ready")).toBeTruthy()
      expect(window.location.search).toBe("")
      expect(window.sessionStorage.getItem(STEP_KEY)).toBe("3")
    })

    it("?guide=1 starts at step 1 and runs nothing", async () => {
      link("1")
      await open()
      await waitFor(() => expect(within(coach()).getByText(/step 1 of 7/)).toBeTruthy())
      expect(posts).toHaveLength(0)
      expect(window.location.search).toBe("")
    })

    it("an unknown value starts nothing", async () => {
      link("nonsense")
      await open()
      await waitFor(() => expect(invite()).toBeTruthy())
      expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull()
      expect(posts).toHaveLength(0)
      expect(window.location.search).toBe("")
    })

    it("with unsaved work it shows the replace warning instead of replacing", async () => {
      const mine = sampleGraph(TEST_REGISTRY, { sha: "ee".repeat(32), filename: "mine.pdf" }, "Mine?")
      savePipeline("Mine", mine)
      storeGraph({ ...mine, nodes: mine.nodes.map((n) => (n.stage === "chunk" ? { ...n, config: { ...n.config, chunk_size: 123 } } : n)) })
      link("chunk")
      await open()
      await waitFor(() => expect(screen.getByText(/This replaces the pipeline you are working on/)).toBeTruthy())
      expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull()
      expect(node("chunk").config.chunk_size).toBe(123)
      expect(posts).toHaveLength(0)
      fireEvent.click(screen.getByRole("button", { name: "Continue" }))
      await waitFor(() => expect(within(coach()).getByText(/step 4 of 7/)).toBeTruthy())
      await waitFor(() => expect(posts).toHaveLength(1))
    })
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

  it("step 1 stays done after a reload", async () => {
    await open(0)
    fireEvent.click(within(coach()).getByRole("button", { name: "Use this document" }))
    await waitFor(() => expect(within(coach()).getByRole("button", { name: "Next step" })).toBeTruthy())
    cleanup()
    resetGuideForTests()
    render(<Shell />)
    await waitFor(() => expect(within(coach()).getByRole("button", { name: "Next step" })).toBeTruthy())
    // Leaving clears it, so a new run starts at the button again.
    fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
    cleanup()
    resetGuideForTests()
    window.sessionStorage.setItem(STEP_KEY, "0")
    render(<Shell />)
    await waitFor(() => expect(coach()).toBeTruthy())
    expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
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

  describe("the Fix step", () => {
    const BEFORE = { artifact: "ret-g", found: { rank: 11 }, shown: 5, candidates: 20 }
    const done = (id: string, artifact_id?: string) => ({ id, status: "done", artifact_id })
    // The guided pipeline with the chunk size at the given value.
    const withSize = (size: number) => {
      const g = sampleGraph(TEST_REGISTRY, { sha: PRIMER.sha, filename: PRIMER.filename }, QUESTION)
      storeGraph({ ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, config: { ...n.config, chunk_size: size } } : n)) })
    }
    const session = (results: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      ...ASKED,
      tracked: { results, history: {} },
      guideAsk: BEFORE,
      ...extra,
    })
    const AFTER_RUN = { retrieve: done("retrieve", "ret-a"), use_case: done("use_case", "out-a"), index: done("index", "idx-1") }
    const runButton = (name: string) => within(coach()).getByRole("button", { name }) as HTMLButtonElement

    it("blocks the run with the reason until Chunk size is the fix value, then enables it", async () => {
      withSize(400)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }))
      expect(runButton("Build the index").disabled).toBe(true)
      expect(within(coach()).getByText(/before building the index/)).toBeTruthy()
      fireEvent.click(within(coach()).getByRole("button", { name: "Open Chunk settings" }))
      fireEvent.change(within(card("chunk")).getByLabelText("Chunk Size"), { target: { value: "800" } })
      await waitFor(() => expect(runButton("Build the index").disabled).toBe(false))
    })

    it("on a phone, the sheet says Before the fix until the question is asked again", async () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((q: string) => ({ matches: q === "(max-width: 47.99rem)" || q === "(max-width: 63.99rem)", addEventListener: () => {}, removeEventListener: () => {} })),
      )
      withSize(400)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }))
      fireEvent.click(await within(coach()).findByRole("button", { name: "See the results" }))
      expect(within(screen.getByRole("dialog", { name: /Ask results/ })).getByText("Before the fix")).toBeTruthy()
    })

    it("names the fix size in the step text whatever the chunk size is now", async () => {
      withSize(400)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }))
      const text = coach().textContent ?? ""
      expect(text).toContain(`chunk size to ${GUIDE_FIX.chunk_size} on the Chunk card`)
      expect(text).not.toContain("400")
    })

    it("gives the size instruction once, and only while Chunk size is not the fix value", async () => {
      withSize(400)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }))
      expect(coach().textContent?.match(/Set Chunk size to 800/g)).toHaveLength(1)
      cleanup()
      withSize(800)
      await open(6, session({ index: done("index", "idx-1"), chunk: done("chunk") }))
      await waitFor(() => expect(runButton("Ask again")).toBeTruthy())
      expect(coach().textContent).not.toMatch(/Set Chunk size to/)
    })

    it("has one Ask again button, not a second one from the hidden Ask panel's transcript", async () => {
      withSize(800)
      const entry = { runId: "old", question: QUESTION, pipeline: "Working copy", reranker: "none", found: null, rows: [], searchIn: undefined }
      await open(6, session({ index: done("index", "idx-1"), chunk: done("chunk") }, { transcript: [entry] }))
      await waitFor(() => expect(runButton("Ask again")).toBeTruthy())
      expect(screen.getAllByRole("button", { name: /Ask again/, hidden: true })).toHaveLength(1)
    })

    it("Build the index runs the index node, not an Ask", async () => {
      withSize(800)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }))
      fireEvent.click(runButton("Build the index"))
      await waitFor(() => expect(posts).toHaveLength(1))
      expect(posts[0].body.through).toBe(node("index").id)
      expect(asks).toHaveLength(0)
    })

    it("once the index is fresh the button reads Ask again and asks", async () => {
      withSize(800)
      await open(6, session({ index: done("index", "idx-1"), chunk: done("chunk") }))
      fireEvent.click(runButton("Ask again"))
      await waitFor(() => expect(asks).toHaveLength(1))
      expect(posts).toHaveLength(0)
    })

    it("shows the rank from before, then the rank after, and the one rule when it improved", async () => {
      withSize(800)
      goldAnswer = { found: { index: 0, gold: "Size factors." } }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("1st"))
      expect(within(coach()).getByRole("status").textContent).toContain("11th")
      expect(within(coach()).getByText(/long sentence or table row/)).toBeTruthy()
      // The Fix is the last step, so its Next reads Finish.
      expect(within(coach()).getByRole("button", { name: "Finish" })).toBeTruthy()
    })

    it("does not claim a fix, or show the rule, when the answer is still not found", async () => {
      withSize(800)
      goldAnswer = { found: null }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("still not found"))
      expect(within(coach()).getByRole("status").textContent).not.toMatch(/moved|1st/)
      expect(within(coach()).queryByText(/long sentence or table row/)).toBeNull()
      expect(within(coach()).getByText(/does not fix every miss/)).toBeTruthy()
    })

    it("shows the Why only when the fix raised the rank", async () => {
      withSize(800)
      goldAnswer = { found: { index: 0, gold: "Size factors." } }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("1st"))
      expect(coach().textContent).toContain("so it rises to the top")
      cleanup()
      resetGuideForTests()
      goldAnswer = { found: null }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("still not found"))
      expect(coach().textContent).not.toContain("so it rises to the top")
    })

    it("does not call it a miss when the Ask step already found the answer among the pieces read", async () => {
      withSize(400)
      await open(6, session({ retrieve: done("retrieve", "ret-g") }, { guideAsk: { artifact: "ret-g", found: { rank: 2 }, shown: 5, candidates: 20 } }))
      expect(coach().textContent).not.toMatch(/miss/)
      expect(coach().textContent).toContain(`set it to ${GUIDE_FIX.chunk_size} on the Chunk card`)
    })

    it("keeps the Ask step's rank and the new rank across a reload without asking again", async () => {
      withSize(800)
      goldAnswer = { found: { index: 0, gold: "Size factors." } }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("1st"))
      cleanup()
      resetGuideForTests()
      goldAnswer = { found: null }
      render(<Shell />)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("1st"))
      expect(within(coach()).getByRole("status").textContent).toContain("11th")
    })

    it("a failed index run shows its error, hides Next and leaves Build the index available", async () => {
      withSize(800)
      await open(6, session({ index: { id: "index", status: "failed", error: "Traceback\nThe model would not load" } }))
      await waitFor(() => expect(within(coach()).getByText("The model would not load")).toBeTruthy())
      expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
      expect(runButton("Build the index").disabled).toBe(false)
    })

    it("goes back to Build the index when another setting makes the built index out of date", async () => {
      withSize(800)
      const g = readStoredGraph(TEST_REGISTRY)!
      const sig = signature(g, "index", TEST_REGISTRY)
      await open(6, session({ index: done("index", "idx-1"), chunk: done("chunk") }, { sigs: { index: sig, chunk: signature(g, "chunk", TEST_REGISTRY) } }))
      expect(runButton("Ask again").disabled).toBe(false)
      fireEvent.click(within(coach()).getByRole("button", { name: "Open Chunk settings" }))
      fireEvent.change(within(card("chunk")).getByLabelText("Chunk Overlap"), { target: { value: "7" } })
      await waitFor(() => expect(runButton("Build the index").disabled).toBe(false))
    })

    it("a failed Ask again shows the error, hides Next and leaves Ask again available", async () => {
      withSize(800)
      askFails = true
      await open(6, session({ index: done("index", "idx-1"), chunk: done("chunk") }))
      fireEvent.click(runButton("Ask again"))
      await waitFor(() => expect(within(coach()).getByText("The search service is down.")).toBeTruthy())
      expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
      expect(runButton("Ask again").disabled).toBe(false)
    })

    it("Leave clears the stored ranks, so a new guided run starts clean", async () => {
      withSize(800)
      await open(6, session(AFTER_RUN, { guideAfter: { artifact: "ret-a", found: { rank: 1 }, shown: 5, candidates: 20 } }))
      fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
      await waitFor(() => {
        const s = JSON.parse(window.sessionStorage.getItem(BUILD_SESSION_KEY) ?? "{}")
        expect(s.guideAsk ?? null).toBeNull()
        expect(s.guideAfter ?? null).toBeNull()
      })
    })
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

  describe("the Ask step", () => {
    // The guided run's own pipeline: the primer and the size-factors question.
    const openAsk = async (session?: unknown) => {
      storeGraph(sampleGraph(TEST_REGISTRY, { sha: PRIMER.sha, filename: PRIMER.filename }, QUESTION))
      await open(5, session)
    }
    it("Run asks once with the size-factors question", async () => {
      await openAsk()
      fireEvent.click(within(coach()).getByRole("button", { name: "Ask the question" }))
      await waitFor(() => expect(asks).toHaveLength(1))
      expect(asks[0]).toContain(QUESTION)
      expect(posts).toHaveLength(0)
    })

    it("says the piece with the answer is below the pieces the answer step reads", async () => {
      goldAnswer = { found: { index: 10, gold: "Size factors." } }
      await openAsk(ASKED)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("11th"))
      expect(within(coach()).getByRole("status").textContent).toContain("below the 5 pieces")
      const results = within(screen.getByRole("region", { name: "Ask results" }))
      expect(results.getByTestId("guide-line").textContent).toContain("5")
      expect(document.querySelectorAll("[data-answer]")).toHaveLength(1)
      expect(within(coach()).getByRole("button", { name: "Next step" })).toBeTruthy()
    })

    it("says no returned piece holds the answer when none does", async () => {
      goldAnswer = { found: null }
      await openAsk(ASKED)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("No piece that was returned holds the answer"))
      expect(document.querySelectorAll("[data-answer]")).toHaveLength(0)
    })

    it("says the piece is among those read when it ranks within them", async () => {
      goldAnswer = { found: { index: 1, gold: "Size factors." } }
      await openAsk(ASKED)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("among the 5 pieces"))
    })

    it("keeps the rank across a reload without asking Pandion again", async () => {
      goldAnswer = { found: { index: 10, gold: "Size factors." } }
      await openAsk(ASKED)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("11th"))
      cleanup()
      resetGuideForTests()
      goldAnswer = { found: null }
      render(<Shell />)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("11th"))
    })

    it("a failed Ask shows the error and hides Next", async () => {
      askFails = true
      await openAsk()
      fireEvent.click(within(coach()).getByRole("button", { name: "Ask the question" }))
      await waitFor(() => expect(within(coach()).getByText("The search service is down.")).toBeTruthy())
      expect(within(coach()).queryByRole("button", { name: "Next step" })).toBeNull()
      expect((within(coach()).getByRole("button", { name: "Ask the question" }) as HTMLButtonElement).disabled).toBe(false)
    })

    it("shows an Ask error that lands on the answer or rerank card, and the reader can Ask again", async () => {
      askFails = true
      askFailDetail = "The use_case step has no model."
      await openAsk()
      fireEvent.click(within(coach()).getByRole("button", { name: "Ask the question" }))
      await waitFor(() => expect(within(coach()).getByText("The use_case step has no model.")).toBeTruthy())
      askFails = false
      fireEvent.click(within(coach()).getByRole("button", { name: "Ask the question" }))
      await waitFor(() => expect(asks).toHaveLength(2))
    })

    it("an Ask error on a search card does not open the hidden dock or change its stored state", async () => {
      const dockState = JSON.stringify({ open: false, side: "right", width: 500 })
      window.localStorage.setItem("rag-playground:ask-dock:v1", dockState)
      askFails = true
      askFailDetail = "The retrieve step failed."
      await openAsk()
      fireEvent.click(within(coach()).getByRole("button", { name: "Ask the question" }))
      await waitFor(() => expect(within(coach()).getByText("The retrieve step failed.")).toBeTruthy())
      expect(window.localStorage.getItem("rag-playground:ask-dock:v1")).toBe(dockState)
      fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
      expect((document.getElementById("ask-dock") as HTMLElement).hidden).toBe(true)
    })

    it("outside the guided run, an Ask error on a search card still opens the dock", async () => {
      window.localStorage.setItem("rag-playground:ask-dock:v1", JSON.stringify({ open: false, side: "right", width: 500 }))
      askFails = true
      askFailDetail = "The retrieve step failed."
      storeGraph(sampleGraph(TEST_REGISTRY, { sha: PRIMER.sha, filename: PRIMER.filename }, QUESTION))
      await open()
      await waitFor(() => expect(invite()).toBeTruthy())
      fireEvent.click(screen.getByRole("button", { name: "I know RAG, hide this" }))
      fireEvent.click(screen.getByRole("button", { name: "Ask" }))
      fireEvent.click(within(document.getElementById("ask-dock")!).getByRole("button", { name: /^Ask$/ }))
      await waitFor(() => expect((document.getElementById("ask-dock") as HTMLElement).hidden).toBe(false))
    })

    it("gives the Why line only when the answer is below the pieces read or not found", async () => {
      goldAnswer = { found: { index: 0, gold: "Size factors." } }
      await openAsk(ASKED)
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("1st"))
      expect(coach().textContent).not.toContain("Why:")
      expect(coach().textContent).not.toContain("may never reach")
      cleanup()
      resetGuideForTests()
      resetSampleQuestionsCache()
      goldAnswer = { found: { index: 10, gold: "Size factors." } }
      window.sessionStorage.removeItem(BUILD_SESSION_KEY)
      await openAsk({ ...ASKED, tracked: { ...ASKED.tracked, results: { ...ASKED.tracked.results, retrieve: { id: "retrieve", status: "done", artifact_id: "ret-a" }, use_case: { id: "use_case", status: "done", artifact_id: "out-a" } } } })
      await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("11th"))
      expect(coach().textContent).toContain("may never reach")
    })

    it("lays the coach out in full below xl: no height cap or inner scroll without the xl prefix", async () => {
      await openAsk()
      const wrap = coach().parentElement as HTMLElement
      for (const el of [coach(), wrap]) {
        const bad = el.className.split(/\s+/).filter((c) => /(^|:)(max-h-|overflow-y-auto)/.test(c) && !c.startsWith("xl:"))
        expect(bad).toEqual([])
      }
    })

    describe("on a phone", () => {
      const phone = () =>
        vi.stubGlobal(
          "matchMedia",
          vi.fn((q: string) => ({ matches: q === "(max-width: 47.99rem)" || q === "(max-width: 63.99rem)", addEventListener: () => {}, removeEventListener: () => {} })),
        )
      it("offers See the results once the sheet is closed, and it reopens the sheet", async () => {
        phone()
        goldAnswer = { found: { index: 10, gold: "Size factors." } }
        await openAsk(ASKED)
        await waitFor(() => expect(screen.getByRole("dialog", { name: /Ask results/ })).toBeTruthy())
        expect(within(coach()).queryByRole("button", { name: "See the results" })).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Close the output" }))
        expect(screen.queryByRole("dialog", { name: /Ask results/ })).toBeNull()
        fireEvent.click(within(coach()).getByRole("button", { name: "See the results" }))
        expect(screen.getByRole("dialog", { name: /Ask results/ })).toBeTruthy()
      })

      it("has no See the results button on a wide screen", async () => {
        goldAnswer = { found: { index: 10, gold: "Size factors." } }
        await openAsk(ASKED)
        await waitFor(() => expect(within(coach()).getByRole("status").textContent).toContain("11th"))
        expect(within(coach()).queryByRole("button", { name: "See the results" })).toBeNull()
      })
    })

    it("hides the Ask dock while the guide is on, and Leave brings it back with its stored state unchanged", async () => {
      const dockState = JSON.stringify({ open: true, side: "right", width: 500 })
      window.localStorage.setItem("rag-playground:ask-dock:v1", dockState)
      await open(5)
      const aside = document.getElementById("ask-dock") as HTMLElement
      expect(aside.hidden).toBe(true)
      fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
      expect(aside.hidden).toBe(false)
      expect(window.localStorage.getItem("rag-playground:ask-dock:v1")).toBe(dockState)
    })
  })

  describe("the ending", () => {
    const done = (id: string, artifact_id?: string) => ({ id, status: "done", artifact_id })
    const withSize = (size: number) => {
      const g = sampleGraph(TEST_REGISTRY, { sha: PRIMER.sha, filename: PRIMER.filename }, QUESTION)
      storeGraph({ ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, config: { ...n.config, chunk_size: size } } : n)) })
    }
    const BEFORE = { artifact: "ret-g", found: { rank: 11 }, shown: 5, candidates: 20 }
    const session = (results: Record<string, unknown>) => ({ ...ASKED, tracked: { results, history: {} }, guideAsk: BEFORE })
    const AFTER_RUN = { retrieve: done("retrieve", "ret-a"), use_case: done("use_case", "out-a"), index: done("index", "idx-1") }
    const finish = async () => {
      withSize(800)
      goldAnswer = { found: { index: 0, gold: "Size factors." } }
      await open(6, session(AFTER_RUN))
      await waitFor(() => expect(within(coach()).getByRole("button", { name: "Finish" })).toBeTruthy())
      fireEvent.click(within(coach()).getByRole("button", { name: "Finish" }))
    }
    const keep = async () => {
      await finish()
      fireEvent.click(within(coach()).getByRole("button", { name: "Save" }))
      await waitFor(() => expect(within(coach()).getByRole("button", { name: "Try it on your own document" })).toBeTruthy())
    }

    it("Finish shows the rule and the save form in the coach", async () => {
      await finish()
      expect(within(coach()).getByLabelText("Keep this pipeline")).toBeTruthy()
      expect(within(coach()).getByText(GUIDE_RULE)).toBeTruthy()
    })

    it("Save then Try it on your own document loads the saved pipeline with no document", async () => {
      await keep()
      const id = readCurrentId()
      expect(id).toBeTruthy()
      fireEvent.click(within(coach()).getByRole("button", { name: "Try it on your own document" }))
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull())
      expect(readCurrentId()).toBe(id)
      expect(documentOf(stored())).toBeNull()
      expect(node("chunk").config.chunk_size).toBe(800)
      const name = readPipelines().find((p) => p.id === id)!.name
      expect(screen.getByText(`Your pipeline ${name} is loaded with its settings. Choose your own PDF on the Document card, then press Build the index.`)).toBeTruthy()
      expect(screen.getByRole("region", { name: "Document" })).toBeTruthy()
      expect(screen.getByRole("region", { name: "Document" }).textContent).not.toMatch(/[–—]/)
    })

    it("Try it on your own document has no dashes and moves focus to the Document region", async () => {
      await keep()
      expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Try it on your own document" }))
      fireEvent.click(within(coach()).getByRole("button", { name: "Try it on your own document" }))
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull())
      const region = screen.getByRole("region", { name: "Document" })
      await waitFor(() => expect(document.activeElement).toBe(region))
      const name = readPipelines().find((p) => p.id === readCurrentId())!.name
      const notice = screen.getByText(new RegExp(`^Your pipeline ${name} is loaded`)).textContent ?? ""
      expect(notice).not.toMatch(/[–—]/)
    })

    it("does not show the Document screen for a frame before the Starter is stored on a first visit", async () => {
      const seen: boolean[] = []
      const watcher = new MutationObserver((records) => {
        for (const r of records)
          for (const n of Array.from(r.addedNodes))
            if (n instanceof Element && (n.matches('section[aria-label="Document"]') || n.querySelector('section[aria-label="Document"]'))) seen.push(true)
      })
      watcher.observe(document.body, { childList: true, subtree: true })
      await open()
      watcher.disconnect()
      expect(seen).toEqual([])
    })

    it("choosing your own PDF after Try it keeps the saved settings and the saved pipeline", async () => {
      await keep()
      const id = readCurrentId()
      fireEvent.click(within(coach()).getByRole("button", { name: "Try it on your own document" }))
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull())
      await act(() => chooseDocument({ sha: "ef".repeat(32), filename: "mine.pdf" }))
      await waitFor(() => expect(documentOf(stored())?.filename).toBe("mine.pdf"))
      expect(node("chunk").config.chunk_size).toBe(800)
      expect(readCurrentId()).toBe(id)
    })
    it("Keep playing here closes the coach and keeps everything", async () => {
      await keep()
      const id = readCurrentId()
      fireEvent.click(within(coach()).getByRole("button", { name: "Keep playing here" }))
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull())
      expect(readCurrentId()).toBe(id)
      expect(documentOf(stored())?.sha).toBe(PRIMER.sha)
      expect(node("chunk").config.chunk_size).toBe(800)
    })

    it("Leave from the ending closes the coach without saving", async () => {
      await finish()
      fireEvent.click(within(coach()).getByRole("button", { name: "Leave the guided run" }))
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Guided run" })).toBeNull())
      expect(readPipelines()).toHaveLength(0)
      expect(documentOf(stored())?.sha).toBe(PRIMER.sha)
    })
  })
})
