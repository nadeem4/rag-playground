import { useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider, useApiKey } from "@/api/apiKey"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetWriteSessionsForTests } from "@/state/writeQuestions"
import liveRegistry from "@/api/fixtures/registry.json"
import type { EvalPayload, EvalQuestionResult, EvaluationRequest, EvaluationResult, GoldQuestion, QuestionSetUpload, Registry, SampleQuestion, Totals } from "@/api/types"
import { afterRun, BEST_KEY, bestKey, readBest } from "@/state/best"
import { graphToConfig, stepOfCardIn } from "@/state/config"
import { readPreviousEvaluation, storePreviousEvaluation } from "@/state/evaluate"
import { chooseDocument, resetDocumentForTests, withDocument } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, setConfig, setTransform, storeGraph } from "@/state/graph"
import { readCurrentId, readPipelines, resetPipelinesForTests, savePipeline, setCurrentId, STARTER_ID } from "@/state/pipelines"
import { ON_BUILD } from "@/state/pipelineChoice"
import { choose, openPicker, optionNames, optionOf } from "@/components/ui/pickerTesting"

import { Evaluate } from "./Evaluate"

const registry = liveRegistry as unknown as Registry
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
const OTHER_SHA = "ab".repeat(32)

const QUESTIONS: SampleQuestion[] = [
  { id: "a", question: "What are the two steps?", gold_answer: "It answers in two steps." },
  { id: "b", question: "How big is a chunk?", gold_answer: "A chunk should answer one question well.", tags: ["designed to miss: long sentence"] },
]

/** Totals as the server sends them. A fixture: the page shows them and adds nothing up. */
const totalsOf = (found: number, total: number): Totals => ({
  total,
  scored: total,
  found,
  hit_rate: total ? found / total : null,
  mrr: total ? found / total : null,
  recall: null,
  mean_rank: found ? 1 : null,
  median_rank: found ? 1 : null,
})

const question = (over: Partial<GoldQuestion>): GoldQuestion => ({
  id: "",
  question: "",
  gold_answers: [],
  answer: "",
  tags: [],
  document: "",
  ...over,
})

function goldSet(over: Partial<QuestionSetUpload> = {}): QuestionSetUpload {
  return {
    sha: SOURCE.sha,
    filename: "refunds.csv",
    format: "csv",
    count: 2,
    set: {
      version: 1,
      document: "handbook.pdf",
      questions: [
        question({ id: "refunds", question: "How long do refunds take?", gold_answers: ["Within ten working days."], tags: ["policy"] }),
        question({ id: "exception", question: "Who approves an exception?", gold_answers: ["The duty manager approves it."], tags: ["policy"] }),
      ],
    },
    stored: true,
    parser: "pdfium",
    parser_note: "The gold passages were looked for in the document as the pdfium parser reads it.",
    summary: { questions: 2, found: 1, found_normalized: 0, not_found: 1 },
    questions: [
      {
        index: 0,
        id: "refunds",
        question: "How long do refunds take?",
        status: "found",
        golds: [{ gold: "Within ten working days.", status: "found", document_text: "", closest: "" }],
      },
      {
        index: 1,
        id: "exception",
        question: "Who approves an exception?",
        status: "not_found",
        golds: [
          { gold: "The duty manager approves it.", status: "not_found", document_text: "", closest: "The duty manager signs it off." },
        ],
      },
    ],
    ...over,
  }
}

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

/**
 * `sampleSha` is the sha the one bundled sample (`chunking-primer`) is served
 * with, which is how the page knows whether that sample's question set
 * describes the loaded document. `null` means the sample list cannot be read.
 * `stored` is what `GET /api/v2/documents/{sha}/questions` has, null for no set.
 */
/** Every POST /api/v2/trace body: there should be none, since the trace comes with the result. */
const traced: unknown[] = []
const TRACE = {
  finding: "Lost at Parse. Fast text put other text in the middle of the answer sentence, so no later step can find it.",
  lost_at: "parse",
  fix: "Use a parser that reads the page layout, such as Docling, then evaluate again.",
  golds: ["A chunk should answer one question well."],
  steps: [
    {
      stage: "parse",
      name: "Parse",
      status: "lost",
      sentence: "The answer's words are here, in order, with other text between them.",
      evidence: { kind: "broken", parts: [{ kind: "answer", text: "A chunk should" }, { kind: "other", text: "column two" }, { kind: "answer", text: "answer one question well." }] },
    },
    { stage: "chunk", name: "Chunk", status: "not_checked", sentence: "Not checked.", evidence: null },
  ],
}

function serve({
  reg = liveRegistry,
  sampleSha = SOURCE.sha,
  stored = null,
  upload,
  demo = false,
  artifacts = {},
  result = null,
  resultFails = 0,
}: {
  reg?: unknown
  sampleSha?: string | null
  stored?: QuestionSetUpload | null
  upload?: QuestionSetUpload | { status: number }
  demo?: boolean
  /** Artifact payloads by id, served at `/api/v2/results/{id}/payload`. */
  artifacts?: Record<string, unknown>
  /** What `GET /api/v2/runs/{id}` answers as the run's result: the server's report. */
  result?: EvaluationResult | null
  /** How many reads of the run fail before one succeeds. */
  resultFails?: number
} = {}): Served {
  const served: Served = { evaluations: [], cancelled: [], reads: 0, urls: [] }
  let fails = resultFails
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      served.urls.push(url)
      if (url === "/api/v2/evaluations" && init?.method === "POST") {
        served.evaluations.push(JSON.parse(String(init.body)) as EvaluationRequest)
        return ok({ run_id: `e${served.evaluations.length}` })
      }
      const cancel = /^\/api\/v2\/runs\/([^/]+)\/cancel$/.exec(url)
      if (cancel && init?.method === "POST") {
        served.cancelled.push(cancel[1])
        return ok({ run_id: cancel[1], cancel_requested: true })
      }
      const snapshot = /^\/api\/v2\/runs\/([^/]+)$/.exec(url)
      if (snapshot) {
        served.reads += 1
        if (fails > 0) {
          fails -= 1
          return new Response("Bad gateway", { status: 502 })
        }
        return ok({ run_id: snapshot[1], kind: "evaluation", status: "finished", ok: true, cancel_requested: false, last_event_id: 0, events: [], result })
      }
      if (url === "/api/v2/trace" && init?.method === "POST") {
        traced.push(JSON.parse(String(init.body)))
        return ok(TRACE)
      }
      const artifact = /^\/api\/v2\/results\/([^/]+)\/payload$/.exec(url)
      if (artifact) return artifact[1] in artifacts ? ok(artifacts[artifact[1]]) : missing()
      if (url === "/api/v2/strategies") return ok({ stages: reg })
      if (url === "/api/settings/app") return ok({ demo })
      if (url === "/api/samples")
        return sampleSha
          ? ok([
              {
                name: "chunking-primer",
                title: "A primer on chunking",
                blurb: "",
                shows: "",
                stresses: "chunk",
                pages: 3,
                default: true,
                filename: "chunking-primer.pdf",
                sha: sampleSha,
                question: "What are the two steps?",
              },
            ])
          : missing()
      if (url === "/api/samples/chunking-primer/questions") return ok(QUESTIONS)
      if (/^\/api\/v2\/documents\/[^/]+\/questions$/.test(url)) {
        if (init?.method === "POST") {
          if (!upload) return missing()
          return "status" in upload ? new Response(JSON.stringify({ detail: "demo" }), { status: upload.status }) : ok(upload)
        }
        if (init?.method === "DELETE") return ok({ deleted: true })
        return stored ? ok(stored) : ok(null)
      }
      return missing()
    }),
  )
  return served
}

/** What the stub server saw: each evaluation's body, each cancel, the reads of a run, every url. */
interface Served {
  evaluations: EvaluationRequest[]
  cancelled: string[]
  reads: number
  urls: string[]
}

/** Serves the default registry, stores the sample graph for `SOURCE`, and renders Evaluate. */
function setup(): Served {
  const served = serve()
  storeGraph(sampleGraph(registry, SOURCE))
  render(<Evaluate />)
  return served
}

/** Opens the Use your own questions fold, where the upload, the templates and the notes live. */
function openOwn() {
  const own = screen.getByText("Use your own questions").closest("details")!
  own.open = true
}

/** A file dropped into the hidden input, which jsdom will not build for us. */
function chooseFile(input: HTMLElement, name: string) {
  const file = new File(["id,question\n"], name, { type: "text/csv" })
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  window.history.replaceState(null, "", "/evaluate")
  resetAppSettingsForTests()
  resetWriteSessionsForTests()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetPipelinesForTests()
  vi.stubGlobal("EventSource", SilentEventSource)
  serve()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Evaluate", () => {
  it("says so plainly when the pipeline has no retriever", async () => {
    // A server with no retrieve plugin: the column is built without one, and
    // `completeGraph` cannot put it back either.
    const { retrieve: _retrieve, ...withoutRetrieve } = registry
    serve({ reg: withoutRetrieve })
    storeGraph(sampleGraph(withoutRetrieve, SOURCE))
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByText("This pipeline has no retriever")).toBeTruthy())
    expect(screen.getByRole("link", { name: "Go to Build" }).getAttribute("href")).toBe("/build")
  })

  it("names the pipeline it would score, counts the questions and waits for a run", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Evaluate" })).toBeTruthy())
    const text = () => document.body.textContent ?? ""
    await waitFor(() => expect(text()).toMatch(/2 questions ready/))
    expect(text()).toMatch(/How often the pipeline on Build finds the answer in chunking-primer\.pdf\./)
    expect(screen.queryByText("Nothing scored yet")).toBeNull()
    expect(screen.getByRole("button", { name: "Evaluate" })).toBeTruthy()
    expect(screen.getByLabelText("Pieces checked").getAttribute("value")).toBe("5")
    expect(screen.getByLabelText("Pieces checked").getAttribute("title")).toBe("Top k: how many of the returned pieces are checked for the answer")
  })

  it("holds the title, the pipeline, Pieces checked and the run button in one header", async () => {
    setup()
    const header = await screen.findByTestId("evaluate-header")
    expect(within(header).getByRole("heading", { level: 1, name: "Evaluate" }).className).toContain("text-2xl")
    expect(within(header).getByLabelText("Pipeline")).toBeTruthy()
    expect((within(header).getByLabelText("Pieces checked") as HTMLInputElement).value).toBe("5")
    expect(within(header).getByRole("button", { name: "Evaluate" })).toBeTruthy()
  })

  it("says what Evaluate does in two sentences, and opens How it is scored in a side sheet", async () => {
    setup()
    const header = await screen.findByTestId("evaluate-header")
    expect(within(header).getByTestId("evaluate-description").textContent).toBe(
      "Test the search with questions you already know the answers to. A question is found when its evidence comes back in the top pieces. No AI judges it, so the same pipeline always gets the same score.",
    )
    const how = within(header).getByRole("button", { name: "How it is scored" })
    fireEvent.click(how)
    const sheet = screen.getByRole("dialog", { name: "How Evaluate scores a pipeline" })
    expect(sheet.getAttribute("aria-modal")).toBe("true")
    expect(within(sheet).getByText("How the text is matched, step by step")).toBeTruthy()
    expect(within(sheet).getByText(/Found, after setting aside the bullet and the stray D/)).toBeTruthy()
    expect(within(sheet).getByText("Mean reciprocal rank")).toBeTruthy()
    expect(within(sheet).getByText("(1 + 1/2 + 0 + 1 + 1/3 + 0) / 6 = 0.47")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("explains Pieces checked with the same info button as Build's fields, and closes it on Escape", async () => {
    setup()
    const info = await screen.findByRole("button", { name: "About Pieces checked" })
    // The shared FieldHelp button: Lucide's Info icon, not a hand-drawn letter.
    expect(info.querySelector("svg")).not.toBeNull()
    expect(info.textContent).toBe("")
    fireEvent.click(info)
    const dialog = await screen.findByRole("dialog", { name: "Pieces checked" })
    expect(dialog.textContent).toMatch(/how many from the top are checked/)
    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pieces checked" })).toBeNull())
  })

  it("lists every question with its evidence before any run", async () => {
    setup()
    await waitFor(() => expect(document.querySelectorAll("[data-question]").length).toBe(2))
    const row = document.querySelector<HTMLElement>('[data-question="a"]')!
    expect(row.querySelector("[data-verdict]")!.textContent).toBe("Not run")
    expect(row.textContent).toContain("Expected answer")
    expect(row.textContent).toContain("None given")
    expect(row.textContent).toContain("Evidence in the document")
    expect(row.textContent).toContain("It answers in two steps.")
    // Nothing to open before a run.
    expect(within(row).queryByRole("button", { name: "Details" })).toBeNull()
  })

  it("says the question set in one line and folds the upload under Use your own questions", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("set-line").textContent).toBe(
        "2 questions from the sample, A primer on chunking. Found means the evidence is in the top 5 pieces. 1 question is planted to miss. Open it after the run to see why.",
      ),
    )
    const own = screen.getByText("Use your own questions").closest("details")!
    expect(own.open).toBe(false)
    expect(within(own).getByRole("link", { name: "JSON" }).className).toContain("inline-flex")
    expect(within(own).getByRole("link", { name: "CSV" }).className).toContain("inline-flex")
    // The 44 px touch box grows without pushing the line apart, and the full stop sits against CSV.
    expect(within(own).getByRole("link", { name: "CSV" }).className).toContain("-my-[11px]")
    expect(within(own).getByRole("link", { name: "CSV" }).parentElement!.textContent).toMatch(/CSV\.$/)
    expect(within(own).getByRole("link", { name: "CSV" }).parentElement!.textContent).not.toMatch(/CSV \.$/)
  })

  it("says the recipe in two lines, the index side and the search side, plain name beside the code name", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("recipe-line").textContent).toMatch(/^Index side:/))
    expect(screen.getByTestId("recipe-line").textContent).toMatch(/Parse: Docling, docling/)
    expect(screen.getByTestId("recipe-line").textContent).toMatch(/Chunk: Recursive \(natural breaks\), recursive_character/)
    expect(screen.getByTestId("recipe-line").textContent).not.toMatch(/Retrieve/)
    const change = within(screen.getByTestId("recipe-line")).getByRole("button", { name: "Change a step on Build" })
    expect(change.className).toContain("inline-flex")
    const search = screen.getByTestId("search-line").textContent!
    expect(search).toMatch(/^Search side:/)
    expect(search).toMatch(/Rewrite: None/)
    expect(search).toMatch(/Retrieve: Hybrid \(RRF\), hybrid_rrf, returns \d+/)
    expect(search).toMatch(/Rerank: None/)
    expect(within(screen.getByTestId("search-line")).getByRole("button", { name: "Change the search settings" })).toBeTruthy()
  })

  it("uses only spacing steps the theme defines (0, 1, 2, 3, 4, 6, 8), since any other step compiles to nothing", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Evaluate.tsx", "components/evaluate/QuestionSetPanel.tsx", "components/evaluate/WriteQuestions.tsx", "components/evaluate/EvalMetrics.tsx"]
    const offScale = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(offScale)
  })

  it("breaks the filename only where it cannot fit", async () => {
    setup()
    const header = await screen.findByTestId("evaluate-header")
    // Both the sentence and the Documents line name it; each wraps only where it must.
    for (const name of within(header).getAllByText("chunking-primer.pdf")) {
      expect(name.className).toContain("break-words")
      expect(name.className).not.toContain("break-all")
    }
  })

  it("uses no sm: class in its files, since the theme has no sm breakpoint", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Evaluate.tsx", "components/evaluate/QuestionSetPanel.tsx", "components/evaluate/WriteQuestions.tsx", "components/evaluate/EvalMetrics.tsx"]
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(/(^|[\s"'`])sm:/m)
  })

  it("has no em-dashes or en-dashes", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    render(<Evaluate />)
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })

  it("shows an error, not a stuck loading line, when the sample list cannot be read (F3)", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v2/strategies") return ok({ stages: liveRegistry })
        if (url === "/api/settings/app") return ok({ demo: false })
        if (url === "/api/samples") return new Response(JSON.stringify({ detail: "down" }), { status: 500 })
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }),
    )
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/down/))
    expect(document.body.textContent).not.toMatch(/Loading the questions/)
  })
})

describe("the question set panel", () => {
  beforeEach(() => storeGraph(sampleGraph(registry, SOURCE)))

  it("names the matched sample, counts it, and links to a template in both formats", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("A primer on chunking"))
    await waitFor(() =>
      expect(screen.getByTestId("set-line").textContent).toBe(
        "2 questions from the sample, A primer on chunking. Found means the evidence is in the top 5 pieces. 1 question is planted to miss. Open it after the run to see why.",
      ),
    )
    openOwn()
    expect(screen.getByRole("link", { name: "JSON" }).getAttribute("href")).toBe("/api/questions/template?format=json")
    expect(screen.getByRole("link", { name: "CSV" }).getAttribute("href")).toBe("/api/questions/template?format=csv")
    expect(screen.getByLabelText("Upload a question set")).toBeTruthy()
  })

  it("says nothing about a mismatch when the loaded document is the sample the questions were written for", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    expect(screen.queryByTestId("set-mismatch")).toBeNull()
  })

  it("has no bundled set for an uploaded document, and says so without a mismatch warning", async () => {
    storeGraph(sampleGraph(registry, { sha: OTHER_SHA, filename: "report.pdf" }))
    serve({ sampleSha: SOURCE.sha })
    render(<Evaluate />)
    expect(await screen.findByText(/No question set for this document/)).toBeTruthy()
    expect(screen.queryByTestId("set-mismatch")).toBeNull()
    // F4: the panel must not contradict that line by claiming a built-in set is in play.
    await waitFor(() => expect(screen.getByTestId("set-line").textContent).toBe("No question set yet."))
  })

  it("uses the set stored against the document, and asks its questions instead of the sample's", async () => {
    serve({ stored: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv"))
    expect(screen.getByTestId("set-line").textContent).toBe("2 questions from refunds.csv. Found means the evidence is in the top 5 pieces.")
    openOwn()
    expect(screen.getByRole("button", { name: "Remove this set" })).toBeTruthy()
    expect(screen.queryByTestId("set-mismatch")).toBeNull()
  })

  it("warns, and offers the removal, when the stored set was uploaded for another document", async () => {
    serve({ stored: goldSet({ sha: OTHER_SHA }) })
    render(<Evaluate />)
    const warning = await screen.findByTestId("set-mismatch", {}, { timeout: 4000 })
    expect(warning.textContent).toMatch(/uploaded for a different document/)
    expect(warning.querySelector("button")!.textContent).toBe("Remove this set")
    // Folding never hides state: the warning stays outside Use your own questions.
    expect(screen.getByTestId("own-questions").contains(warning)).toBe(false)
  })

  it("goes back to the sample set when the uploaded one is removed", async () => {
    serve({ stored: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv"))
    openOwn()
    fireEvent.click(screen.getByRole("button", { name: "Remove this set" }))
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("A primer on chunking"))
  })

  it("says an uploaded set lives in this browser tab when the server would not keep it", async () => {
    serve({ upload: goldSet({ stored: false }) })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")
    const note = await screen.findByTestId("tab-only", {}, { timeout: 4000 })
    expect(note.textContent).toMatch(/this browser tab only/)
    expect(note.textContent).toMatch(/goes when you close the tab/)
    // And it comes back on the next visit to the page, because the server has none.
    cleanup()
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv"))
    expect(screen.getByTestId("tab-only")).toBeTruthy()
  })

  it("says up front that a hosted demo does not keep question sets", async () => {
    serve({ demo: true })
    render(<Evaluate />)
    await screen.findByText("Use your own questions", {}, { timeout: 4000 })
    openOwn()
    const note = await screen.findByTestId("demo-note", {}, { timeout: 4000 })
    // It works here, for as long as the tab stays open: the note says so instead of sending people away.
    expect(note.textContent).toMatch(/an uploaded set lasts until you close this browser tab/)
    expect(note.textContent).not.toMatch(/does not store/)
    expect(screen.getByRole("link", { name: "Run the playground locally" }).className).toContain("inline-flex")
  })

  it("explains itself when the server refuses the upload outright", async () => {
    serve({ upload: { status: 403 } })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    chooseFile(screen.getByLabelText("Upload a question set"), "mine.csv")
    const err = await screen.findByTestId("set-error", {}, { timeout: 4000 })
    expect(err.textContent).toMatch(/does not store question sets/)
  })
})

describe("questions written for you", () => {
  beforeEach(() => storeGraph(sampleGraph(registry, SOURCE)))

  it("offers Write questions for me inside Use your own questions, and it opens the sheet", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    const own = screen.getByTestId("own-questions")
    const button = within(own).getByRole("button", { name: "Write questions for me" })
    expect(own.textContent).toMatch(/A model reads this document and writes test questions with their evidence, on your own key\./)
    fireEvent.click(button)
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Write questions for me" })).toBeTruthy()
  })

  it("saves the kept questions through the upload, and the set line names the model and the document", async () => {
    const saved = goldSet({
      filename: "questions written by Claude Haiku 4.5.json",
      format: "json",
      count: 1,
      set: { version: 1, document: "chunking-primer.pdf", questions: [question({ id: "q1", question: "Which two steps?", gold_answers: ["It answers in two steps."] })] },
      summary: { questions: 1, found: 1, found_normalized: 0, not_found: 0 },
      questions: [],
    })
    serve({ upload: saved })
    const base = fetch
    const uploads: File[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
        if (url.endsWith("/questions/generate")) return ok({ run_id: "w1" }, 202)
        if (url === "/api/v2/runs/w1")
          return ok({
            run_id: "w1", kind: "questions", status: "finished", ok: true, cancel_requested: false, last_event_id: 1, events: [],
            result: {
              questions: [{ id: "q1", question: "What are the two steps?", gold_answers: ["It answers in two steps."], answer: "", tags: [] }],
              dropped: [],
              usage: { input_tokens: 900, output_tokens: 200, model: "claude-haiku-4-5" },
            },
          })
        if (url.endsWith("/questions") && init?.method === "POST") uploads.push((init.body as FormData).get("file") as File)
        return base(url, init)
      }),
    )
    let stream: { onmessage: ((ev: MessageEvent) => void) | null } | null = null
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((ev: MessageEvent) => void) | null = null
        onerror = null
        onopen = null
        constructor() {
          stream = this
        }
        close() {}
      },
    )
    function WithKey() {
      const { setKey } = useApiKey()
      useEffect(() => setKey("anthropic", "sk-ant-test"), [setKey])
      return null
    }
    render(
      <ApiKeyProvider>
        <WithKey />
        <Evaluate />
      </ApiKeyProvider>,
    )
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    fireEvent.click(within(screen.getByTestId("own-questions")).getByRole("button", { name: "Write questions for me" }))
    fireEvent.click(await screen.findByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(stream).not.toBeNull())
    act(() => stream!.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ts: 1, event: "stream_end", status: "finished", ok: true }), lastEventId: "0" })))
    const sheet = await screen.findByRole("dialog")
    const row = (await within(sheet).findByText("What are the two steps?")).closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "Which two steps?" } })
    fireEvent.click(within(row).getByRole("button", { name: "Done" }))
    fireEvent.click(within(sheet).getByRole("button", { name: "Save 1 question" }))

    await waitFor(() => expect(uploads).toHaveLength(1))
    expect(JSON.parse(await uploads[0].text()).questions).toEqual([
      { id: "q1", question: "Which two steps?", gold_answers: ["It answers in two steps."], answer: "", tags: [] },
    ])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const line = screen.getByTestId("set-line").textContent!
    expect(line).toMatch(/^1 question you kept, written by Claude Haiku 4\.5 from chunking-primer\.pdf\./)
    expect((screen.getByTestId("own-questions") as HTMLDetailsElement).open).toBe(false)
  })
})

describe("the upload report", () => {
  beforeEach(() => storeGraph(sampleGraph(registry, SOURCE)))

  it("says how many questions were read and names every gold passage that is not in the document", async () => {
    serve({ upload: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")

    const report = await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    expect(screen.getByTestId("own-questions").contains(report)).toBe(false)
    expect(report.textContent).toMatch(/Read 2 questions from refunds.csv/)
    expect(report.textContent).toMatch(/1 of 2 gold passages was not found/)
    expect(report.textContent).toMatch(/The duty manager approves it\./)
    expect(report.textContent).toMatch(/The duty manager signs it off\./)
    expect(report.textContent).toMatch(/as the pdfium parser reads it/)
    expect(within(report).getByText("The duty manager approves it.").className).not.toContain("font-mono")
    expect(within(report).getByText("The duty manager signs it off.").className).not.toContain("font-mono")
    // A set with problems is still in use: the page swapped to it.
    expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv")
  })

  it("shows the closest text as a single evidence slip with no scores, and the gold answer in the serif", async () => {
    serve({ upload: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")
    const report = await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    const slip = report.querySelector("[data-slip]") as HTMLElement
    expect(slip).toBeTruthy()
    expect(within(slip).getByTestId("passage").textContent).toBe("The duty manager signs it off.")
    expect(within(slip).getByTestId("passage").className).toContain("font-serif")
    // No rank, score or page is known, so the slip is bare: no finding line and no meta line, nothing invented.
    expect(within(slip).queryByTestId("finding")).toBeNull()
    expect(within(slip).queryByTestId("meta")).toBeNull()
    expect(slip.className).not.toContain(":hidden")
    expect(slip.textContent).toBe("The duty manager signs it off.")
    expect(within(report).getByText("The duty manager approves it.").className).toContain("font-serif")
  })

  it("stays on screen after the set is in use, and has no em-dashes or en-dashes", async () => {
    serve({ upload: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    openOwn()
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")
    await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    expect(screen.getByTestId("upload-report")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})

describe("Evaluate is pipeline first", () => {
  const picker = () => screen.getByRole("button", { name: /^Pipeline/ }) as HTMLButtonElement
  const picked = () => picker().getAttribute("data-picked")
  const evaluateButton = () => screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement
  const tokens = () => setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry)
  const UP = { sha: "12".repeat(32), filename: "my-notes.pdf", size: 7451, content_type: "application/pdf" }

  /** Lists one upload in this browser, so Change has another document to offer. */
  function withUpload() {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => (url === "/api/v2/documents" ? Promise.resolve(new Response(JSON.stringify([UP]), { status: 200 })) : base(url, init))),
    )
  }

  it("opens on the Starter with its document and question set when nothing is chosen, so one press scores it", async () => {
    const { evaluations, urls } = serve()
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    expect(screen.queryByText("No pipeline to evaluate")).toBeNull()
    expect(picker().textContent).toContain("Starter pipeline")
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Starter pipeline finds the answer in chunking-primer\.pdf\./))
    expect(within(screen.getByTestId("documents-line")).getByText("chunking-primer.pdf")).toBeTruthy()
    expect(screen.getByTestId("documents-hint").textContent).toBe("The Starter comes with the default sample. Change it to try another.")
    await waitFor(() => expect(evaluateButton().disabled).toBe(false))
    fireEvent.click(evaluateButton())
    await waitFor(() => expect(evaluations).toHaveLength(1))
    // One request with the pipeline as a Pandion config, its document and every question.
    const sent = evaluations[0]
    expect(sent.documents).toEqual([SOURCE.sha])
    expect(sent.config.index.chunk).toMatchObject({ chunk_size: 400, chunk_overlap: 80 })
    expect(sent.questions.map((q) => q.id)).toEqual(["a", "b"])
    expect(sent.questions[1]).toEqual({ id: "b", question: "How big is a chunk?", gold_answers: ["A chunk should answer one question well."], tags: ["designed to miss: long sentence"] })
    expect(sent.top_k).toBe(5)
    expect(urls.some((u) => u.startsWith("/api/v2/comparisons"))).toBe(false)
  })

  it("lists Ready to use, Your pipelines, On Build and Build your own, in that order", async () => {
    savePipeline("Token chunks", tokens())
    setCurrentId(null)
    storeGraph(setTransform(sampleGraph(registry, SOURCE), "chunk", "sentence_window", registry))
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(ON_BUILD))
    expect(optionNames(picker())).toEqual(["Starter pipeline", "Token chunks", "The pipeline on Build", "Build your own…"])
    const list = openPicker(picker())
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Ready to use", "Your pipelines", "On Build"])
    expect(within(list).getByRole("option", { name: /^Starter pipeline/ }).textContent).toContain("Ready-made")
    expect(within(list).getByRole("option", { name: /^The pipeline on Build/ }).textContent).toContain("Not saved")
  })

  it("lists On Build only when Build's pipeline is not saved, and then opens on Build's own selection", async () => {
    const saved = savePipeline("Token chunks", tokens())!.saved
    storeGraph(tokens())
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(saved.id))
    expect(optionNames(picker())).toEqual(["Starter pipeline", "Token chunks", "Build your own…"])
    expect(document.body.textContent).toMatch(/How often Token chunks finds the answer in chunking-primer\.pdf\./)
  })

  it("scores a saved pipeline on its own documents", async () => {
    const other = withDocument(tokens(), { sha: OTHER_SHA, filename: "other.pdf" })
    savePipeline("Token chunks", other)
    setCurrentId(null)
    serve()
    render(<Evaluate />)
    choose(await screen.findByRole("button", { name: /^Pipeline/ }), "Token chunks")
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Token chunks finds the answer in other\.pdf\./))
    expect(within(screen.getByTestId("documents-line")).getByText("other.pdf")).toBeTruthy()
  })

  it("lists the pipeline's documents with the full element, its Preview, and Change beside the Documents label", async () => {
    serve()
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    const list = screen.getByTestId("documents-line")
    const items = await within(list).findAllByTestId("document-item")
    expect(items).toHaveLength(1)
    await waitFor(() => expect(within(items[0]).getByText("A primer on chunking")).toBeTruthy())
    expect(within(items[0]).getByTestId("document-facts").textContent).toContain("Sample")
    fireEvent.click(within(items[0]).getByRole("button", { name: "Preview A primer on chunking" }))
    expect(screen.getByRole("dialog", { name: "A primer on chunking" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Change the document. Now chunking-primer.pdf." })).toBeTruthy()
  })

  it("Change tries the pipeline on another document and leaves the saved pipeline as it was", async () => {
    const saved = savePipeline("Token chunks", tokens())!.saved
    setCurrentId(null)
    serve()
    withUpload()
    render(<Evaluate />)
    choose(await screen.findByRole("button", { name: /^Pipeline/ }), "Token chunks")
    const change = await screen.findByRole("button", { name: "Change the document. Now chunking-primer.pdf." })
    fireEvent.keyDown(change, { key: "Enter" })
    const menu = await screen.findByRole("menu")
    fireEvent.click(await within(menu).findByRole("menuitemradio", { name: /my-notes\.pdf/ }))
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Token chunks finds the answer in my-notes\.pdf\./))
    expect(screen.getByTestId("documents-hint").textContent).toBe("Trying Token chunks on my-notes.pdf. The saved pipeline keeps chunking-primer.pdf.")
    expect(readPipelines().find((p) => p.id === saved.id)!.documents).toEqual([SOURCE])
    // Another pipeline brings its own documents back.
    choose(picker(), "Starter pipeline")
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Starter pipeline finds the answer in chunking-primer\.pdf\./))
  })

  it("a visitor's own PDF on the Starter is the pipeline on Build: Evaluate lists it and opens on it", async () => {
    // A fresh visitor on Build (the Starter) uploads a PDF with Change: the selection stays the Starter.
    serve()
    withUpload()
    storeGraph(withDocument(sampleGraph(registry, SOURCE, "What are the two steps?"), { sha: UP.sha, filename: UP.filename }))
    setCurrentId(STARTER_ID)
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(ON_BUILD))
    expect(optionNames(picker())).toEqual(["Starter pipeline", "The pipeline on Build", "Build your own…"])
    await waitFor(() => expect(document.body.textContent).toMatch(/How often the pipeline on Build finds the answer in my-notes\.pdf\./))
  })

  it("Change a step on Build opens the selected pipeline there, from Evaluate, and warns when that replaces unsaved work", async () => {
    const saved = savePipeline("Token chunks", tokens())!.saved
    setCurrentId(null)
    storeGraph(setTransform(sampleGraph(registry, SOURCE), "chunk", "sentence_window", registry))
    const navigate = vi.fn()
    render(<Evaluate navigate={navigate} />)
    await waitFor(() => expect(picked()).toBe(ON_BUILD))
    // The pipeline on Build is already there: opening it replaces nothing.
    expect(screen.queryByTestId("replaces-unsaved")).toBeNull()
    choose(picker(), "Token chunks")
    await waitFor(() => expect(screen.getByTestId("replaces-unsaved").textContent).toBe("Opening it on Build replaces the unsaved pipeline there."))
    fireEvent.click(screen.getByRole("button", { name: "Change a step on Build" }))
    expect(navigate).toHaveBeenCalledWith("/build?from=evaluate")
    expect(readCurrentId()).toBe(saved.id)
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "chunk")!.transform).toBe("token_based")
    navigate.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Change the search settings" }))
    expect(navigate).toHaveBeenCalledWith("/build?from=evaluate")
  })

  it("says how many questions are planted to miss", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("planted-line").textContent).toBe("1 question is planted to miss. Open it after the run to see why."))
  })

  it("opens on the pipeline a link names", async () => {
    const saved = savePipeline("Token chunks", tokens())!.saved
    setCurrentId(null)
    window.history.replaceState(null, "", `/evaluate?pipeline=${saved.id}`)
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(saved.id))
    expect(window.location.search).toBe("")
  })

  it("Build your own opens a side sheet, asks for a name, then saves and selects the new pipeline without touching Build", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    choose(picker(), "Build your own…")
    const sheet = await screen.findByRole("dialog", { name: "Build your own pipeline" })
    expect(picked()).toBe(STARTER_ID)
    fireEvent.click(within(sheet).getByRole("button", { name: "Save and select" }))
    expect(within(sheet).getByRole("alert").textContent).toBe("Give it a name, so you can find it in the list.")
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Bigger pieces" } })
    choose(within(sheet).getByRole("button", { name: /^Chunk/ }), "By sentence")
    fireEvent.click(within(sheet).getByRole("button", { name: "Save and select" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const saved = readPipelines()[0]
    expect(saved.name).toBe("Bigger pieces")
    expect(saved.documents).toEqual([SOURCE])
    expect(picked()).toBe(saved.id)
    expect(readCurrentId()).toBeNull()
  })

  it("Open on Build stores the sheet's pipeline as an unsaved one on Build and goes there", async () => {
    const navigate = vi.fn()
    render(<Evaluate navigate={navigate} />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    choose(picker(), "Build your own…")
    const sheet = await screen.findByRole("dialog", { name: "Build your own pipeline" })
    choose(within(sheet).getByRole("button", { name: /^Chunk/ }), "By sentence")
    fireEvent.click(within(sheet).getByRole("button", { name: "Open on Build to watch each step" }))
    expect(navigate).toHaveBeenCalledWith("/build?from=evaluate")
    expect(readStoredGraph(registry)!.nodes.find((n) => n.stage === "chunk")!.transform).toBe("sentence_window")
    expect(readCurrentId()).toBeNull()
  })

  it("lists a saved pipeline this server cannot run as not usable, and never opens on it (M7)", async () => {
    const graph = sampleGraph(registry, SOURCE)
    savePipeline("Semantic", { ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) })
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    const option = optionOf(picker(), "Semantic")
    expect(option.textContent).toContain("Cannot run")
    expect(option.getAttribute("aria-disabled")).toBe("true")
  })

  it("keeps the picker's own element, and so its focus, when the pipeline changes", async () => {
    savePipeline("Token chunks", tokens())
    setCurrentId(null)
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(STARTER_ID))
    const before = picker()
    before.focus()
    choose(before, "Token chunks")
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Token chunks finds/))
    expect(picker()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it("compares an edited pipeline on Build against its own last score", async () => {
    const saved = savePipeline("Token chunks", tokens())!.saved
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: saved.id, byId: {}, totals: totalsOf(1, 2) })
    storeGraph(sampleGraph(registry, SOURCE))
    render(<Evaluate />)
    await waitFor(() => expect(picked()).toBe(ON_BUILD))
    expect(document.body.textContent).toMatch(/How often Token chunks \(edited\) finds the answer in chunking-primer\.pdf\./)
    expect((await screen.findByTestId("previous")).textContent).toMatch(/found 1 of 2/)
  })

  it("holds the pipeline still while an evaluation runs (M8)", async () => {
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picker().disabled).toBe(false)
    await waitFor(() => expect(evaluateButton().disabled).toBe(false))
    fireEvent.click(evaluateButton())
    await waitFor(() => expect(picker().disabled).toBe(true))
  })

  it("says so, with a way on, when the samples cannot be read and nothing is saved", async () => {
    serve({ sampleSha: null })
    render(<Evaluate />)
    expect(await screen.findByText("The Starter pipeline is not ready")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Build a pipeline on Build" }).getAttribute("href")).toBe("/build")
  })
})

/** An event stream the test drives, one per run. */
class DrivenEventSource {
  static instances: DrivenEventSource[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror = null
  onopen = null
  constructor() {
    DrivenEventSource.instances.push(this)
  }
  close() {}
  emit(seq: number, event: Record<string, unknown>) {
    act(() => {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ts: seq, ...event }), lastEventId: String(seq) }))
    })
  }
}

/** The eval step's payload for one question, as the server puts it under `score`. */
const score = (over: Partial<EvalPayload> = {}): EvalPayload => ({
  question: "q",
  gold_answer: "g",
  hit: true,
  rank: 1,
  matched_chunk_id: "c1",
  match: "exact",
  considered: 3,
  total_candidates: 3,
  golds_total: 1,
  golds_found: 1,
  found_at: null,
  ...over,
})

/** One question's verdict in the server's report. */
const verdict = (id: string, over: Partial<EvalQuestionResult> = {}): EvalQuestionResult => {
  const s = over.score ?? score()
  return { id, question: "", golds: [], tags: [], found: s.hit, rank: s.rank, lost_at: null, trace: null, score: s, error: null, result_id: null, ...over }
}

/**
 * The server's report for these verdicts (pandion.evaluation's `to_dict`).
 * The totals are this test's fixture: the page shows them and adds nothing up.
 */
const report = (questions: EvalQuestionResult[], over: Partial<EvaluationResult> = {}): EvaluationResult => ({
  top_k: 5,
  cancelled: false,
  ...totalsOf(questions.filter((q) => q.found).length, questions.length),
  by_tag: {},
  questions,
  ...over,
})

describe("while and after scoring", () => {
  const graph = sampleGraph(registry, SOURCE)
  const idOf = (stage: string) => graph.nodes.find((n) => n.stage === stage)!.id
  /** One step's event in a question's run, named as Pandion names it (`search`, `clean.1`). */
  const step = (question: string, card: string, event: string, extra: Record<string, unknown> = {}) => {
    const name = stepOfCardIn(graph, card)
    return { event, node_id: name, step: name, document: null, question, ...extra }
  }
  const finished = (question: string, card: string, artifact: string, cached = false) =>
    step(question, card, "node_finished", { artifact_id: artifact, cache_hit: cached, duration_ms: 1 })
  const done = (question: string, number: number, found: boolean, error: string | null = null) => ({ event: "question_finished", question, number, total: 2, found, error })

  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  async function start(opts: Parameters<typeof serve>[0] = {}) {
    const served = serve(opts)
    storeGraph(graph)
    render(<Evaluate />)
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    return { es: DrivenEventSource.instances[0], served }
  }

  it("gives every state an icon, the same in the row and in its mark, with the word beside it in the row", async () => {
    serve()
    storeGraph(graph)
    render(<Evaluate />)
    const icon = (el: Element) => el.querySelector("[data-icon]")?.getAttribute("data-icon")
    const rows = () => [...document.querySelectorAll("[data-question]")]
    await waitFor(() => expect(rows()).toHaveLength(2))
    // Before a run: a quiet empty circle and the words Not run.
    expect(rows().map((r) => icon(r.querySelector("[data-verdict]")!))).toEqual(["not-run", "not-run"])
    expect(rows()[0].querySelector("[data-verdict]")!.textContent).toBe("Not run")
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    DrivenEventSource.instances = []
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    const es = DrivenEventSource.instances[0]
    const marks = () => within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    await waitFor(() => expect(marks().map(icon)).toEqual(["waiting", "waiting"]))
    expect(rows().map((r) => icon(r.querySelector("[data-verdict]")!))).toEqual(["waiting", "waiting"])
    // The first question's run builds the index first. The rewrite step has no inputs, so it
    // runs at once; the question waits until the search starts, which needs the finished index.
    es.emit(2, step("a", "query", "node_started", { transform: "x", artifact_id: "q0" }))
    es.emit(3, step("a", "chunk", "node_started", { transform: "x", artifact_id: "c0" }))
    await new Promise((r) => setTimeout(r, 20))
    expect(marks().map(icon)).toEqual(["waiting", "waiting"])
    expect(rows()[0].querySelector("[data-verdict]")!.textContent).toBe("Waiting")
    expect(screen.getByTestId("progress-line").textContent).toBe("Building the index first. Questions are scored once it is ready.")
    es.emit(4, step("a", idOf("retrieve"), "node_started", { transform: "x", artifact_id: "r0" }))
    await waitFor(() => expect(marks().map(icon)).toEqual(["running", "waiting"]))
    expect(marks()[0].getAttribute("aria-label")).toBe("Question 1, running")
    expect(screen.getByTestId("progress-line").textContent).toBe("Searching and scoring question 1 of 2.")
    const spinner = marks()[0].querySelector("[data-icon]")!
    expect(spinner.getAttribute("aria-hidden")).toBe("true")
    expect(spinner.getAttribute("class")).toContain("icon-spin")
    expect(rows()[0].querySelector("[data-verdict]")!.textContent).toBe("Running")
    es.emit(5, done("a", 1, false, "The search step failed: ValueError: boom"))
    await waitFor(() => expect(marks().map(icon)[0]).toBe("failed"))
    expect(icon(rows()[0].querySelector("[data-verdict]")!)).toBe("failed")
    expect(rows()[0].querySelector("[data-reason]")!.textContent).toBe("The search step failed: ValueError: boom")
  })

  it("fills each row in as its question finishes, before the scores arrive", async () => {
    const { es } = await start()
    es.emit(1, finished("a", idOf("retrieve"), "r0"))
    es.emit(2, done("a", 1, true))
    const marks = () => within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    await waitFor(() => expect(marks()[0].getAttribute("aria-label")).toBe("Question 1, found"))
    expect(screen.getByTestId("progress-line").textContent).toBe("Searching and scoring question 2 of 2.")
    expect(screen.getByRole("progressbar", { name: "Questions scored" }).getAttribute("aria-valuenow")).toBe("1")
  })

  it("while the busy demo makes the run wait, says so instead of a question count", async () => {
    const { es } = await start()
    es.emit(0, { event: "queued", ahead: 0 })
    await waitFor(() => expect(document.body.textContent).toContain("The demo is busy with other learners. Your run starts in a moment."))
    expect(document.body.textContent).not.toContain("scoring question")
    es.emit(1, { event: "unqueued" })
    await waitFor(() => expect(screen.getByTestId("progress-line").textContent).toBe("Building the index first. Questions are scored once it is ready."))
  })

  it("says which question it is scoring while busy, and shows the server's numbers once done", async () => {
    const { es, served } = await start({
      result: report([verdict("a"), verdict("b", { score: score({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: 7, total_candidates: 12 }) })], {
        // The server's numbers, which the page shows as they are.
        hit_rate: 0.5,
        mrr: 0.5,
      }),
    })
    await waitFor(() => expect(screen.getByTestId("progress-line").textContent).toBe("Building the index first. Questions are scored once it is ready."))
    expect(screen.getByTestId("index-line").textContent).toBe("Waiting to start")
    expect(screen.getByRole("progressbar", { name: "Questions scored" }).getAttribute("aria-valuemax")).toBe("2")
    // Every mark is drawn at once, and waits until its row lands.
    const waiting = within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    expect(waiting.map((m) => m.getAttribute("aria-label"))).toEqual(["Question 1, waiting", "Question 2, waiting"])
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByTestId("numbers")).toBeNull()

    es.emit(1, done("a", 1, true))
    es.emit(2, done("b", 2, false))
    expect(served.reads).toBe(0)
    es.emit(3, { event: "stream_end", status: "finished", ok: true })

    const summary = await screen.findByTestId("summary")
    expect(summary.textContent).toBe("1 of 2 questions found the answer.")
    expect(summary.className).toContain("text-[1.375rem]")
    expect(summary.className).toContain("max-w-[52ch]")
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)50%")
    expect(screen.getByTestId("numbers").textContent).toContain("Mean reciprocal rank (MRR)0.50")
    expect(screen.queryByTestId("score-note")).toBeNull()
    expect(summary.className).not.toContain("font-mono")
    expect(summary.querySelector("span.font-mono")).not.toBeNull()
    expect(screen.queryByTestId("progress")).toBeNull()
    expect(document.body.textContent).toContain("Found 7th, below the 5 pieces checked.")
    // The verdict and the reason in sans; mono only on the digits.
    for (const row of document.querySelectorAll<HTMLElement>("li[data-question]")) {
      const v = row.querySelector<HTMLElement>("[data-verdict]")!
      expect(v.className).toContain("font-sans")
      expect(v.className).toContain("font-semibold")
      expect(v.querySelector(".font-mono")).toBeNull()
      const reason = row.querySelector<HTMLElement>("[data-reason]")!
      expect(reason.className).not.toContain("font-mono")
      expect([...reason.querySelectorAll(".font-mono")].every((m) => /^[\d,.]+$/.test(m.textContent ?? ""))).toBe(true)
      expect(reason.querySelector(".font-mono")).not.toBeNull()
    }
  })

  it("shows the server's numbers, not its own sums, and the server's count per tag", async () => {
    const { es } = await start({
      result: report([verdict("a"), verdict("b")], {
        // Numbers the page could never work out from the rows: they must come through as sent.
        hit_rate: 0.37,
        mrr: 0.123,
        by_tag: { "designed to miss: long sentence": totalsOf(0, 1) },
      }),
    })
    es.emit(1, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)37%")
    expect(screen.getByTestId("numbers").textContent).toContain("Mean reciprocal rank (MRR)0.12")
    expect(screen.getByTestId("by-tag").textContent).toContain("By tag: designed to miss: long sentence 0 of 1 found.")
  })

  it("reads the scores a second time when the first read fails", async () => {
    const { es, served } = await start({ result: report([verdict("a"), verdict("b")]), resultFails: 1 })
    es.emit(1, { event: "stream_end", status: "finished", ok: true })
    expect((await screen.findByTestId("summary")).textContent).toBe("2 of 2 questions found the answer.")
    expect(served.reads).toBe(2)
    expect(screen.queryByTestId("scores-unread")).toBeNull()
  })

  it("says the scores could not be read, and shows no numbers, when both reads fail", async () => {
    const { es } = await start({ result: report([verdict("a"), verdict("b")]), resultFails: 2 })
    es.emit(1, done("a", 1, true))
    es.emit(2, done("b", 2, true))
    es.emit(3, { event: "stream_end", status: "finished", ok: true })
    const unread = await screen.findByTestId("scores-unread")
    expect(unread.textContent).toBe("The scores could not be read. Run it again.")
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByTestId("numbers")).toBeNull()
    expect(screen.getByRole("button", { name: "Evaluate again" })).toBeTruthy()
  })

  it("never says every answer came back first when a question's search failed", async () => {
    const { es } = await start({
      result: report([verdict("a"), verdict("b", { found: false, rank: null, score: {} as EvalPayload, error: "The search step failed." })], {
        ...totalsOf(1, 2),
        scored: 1,
        hit_rate: 1,
      }),
    })
    es.emit(1, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")
    expect(screen.queryByTestId("score-note")).toBeNull()
    expect(document.body.textContent).not.toContain("Every answer came back as the top piece.")
    expect(document.querySelector('[data-question="b"] [data-verdict]')!.textContent).toBe("Failed")
  })

  it("shows Build's run strip while the index builds, and keeps a summary of what came from the cache after the run", async () => {
    const { es } = await start({ result: report([verdict("a"), verdict("b")]) })
    const index = graph.nodes.filter((n) => ["parse", "clean", "chunk", "index"].includes(n.stage))
    es.emit(1, step("a", index[0].id, "node_started", { ts: 1 }))
    await waitFor(() => expect(screen.getByTestId("run-line").textContent).toMatch(/^Running /))
    expect(screen.getByRole("list", { name: "Index steps" })).toBeTruthy()
    let n = 2
    for (const node of index) es.emit(n++, finished("a", node.id, `a-${node.id}`, true))
    es.emit(n++, finished("a", idOf("retrieve"), "r0", true))
    es.emit(n++, done("a", 1, true))
    es.emit(n++, finished("b", idOf("retrieve"), "r1", true))
    es.emit(n++, done("b", 2, true))
    es.emit(n++, { event: "stream_end", status: "finished", ok: true })
    const summary = await screen.findByTestId("run-summary")
    expect(within(summary).getByTestId("run-line").textContent).toBe("From the cache, nothing ran again")
    expect(summary.textContent).toContain("2 searches, all from the cache.")
    await waitFor(() => expect(screen.getByTestId("run-summary").textContent).toMatch(/Took [\d.]+ s\./))
  })

  it("keeps saying the k that was scored when Pieces checked changes after the run", async () => {
    const pieces = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}` }))
    const { es } = await start({
      artifacts: { c7: { chunks: pieces } },
      result: report([verdict("a"), verdict("b", { score: score({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: 7, total_candidates: 12 }) })]),
    })
    es.emit(1, finished("a", idOf("chunk"), "c7"))
    es.emit(2, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")
    await waitFor(() => expect(document.body.textContent).toContain("Found 7th, below the 5 pieces checked."))
    await screen.findByTestId("pieces-warning")

    fireEvent.change(screen.getByLabelText("Pieces checked"), { target: { value: "10" } })
    expect((screen.getByLabelText("Pieces checked") as HTMLInputElement).value).toBe("10")

    expect(document.body.textContent).toContain("Found 7th, below the 5 pieces checked.")
    expect(document.body.textContent).not.toContain("below the 10 pieces")
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)")
    expect(screen.getByTestId("stale-k").textContent).toBe("Scored at 5 pieces. Evaluate again to use 10.")
    expect(screen.getByTestId("k-line").textContent).toBe("Scored at 5 pieces. The pipeline makes 7 pieces.")
    expect(screen.getByTestId("pieces-warning").textContent).toBe(
      "With 7 pieces and 5 checked, a hit says little. A miss still says a lot: its answer was not in the top 5.",
    )
    expect(screen.getByTestId("pieces-warning").className).toContain("bg-warn")
  })

  /** Runs the two questions to the end: a found one and a missed one. */
  async function finishTwo(missed: Partial<EvalPayload> = {}, over: Partial<EvalQuestionResult> = {}) {
    const { es, served } = await start({
      result: report([verdict("a"), verdict("b", { score: score({ hit: false, rank: null, matched_chunk_id: "", match: "none", returned: 3, ...missed }), ...over })]),
    })
    es.emit(1, done("a", 1, true))
    es.emit(2, done("b", 2, false))
    es.emit(3, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")
    return served
  }

  it("opens a fresh evaluation when the document changes", async () => {
    await finishTwo()
    expect(screen.getByTestId("summary")).toBeTruthy()
    await act(() => chooseDocument({ sha: OTHER_SHA, filename: "other.pdf" }))
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByText("Was found 1st")).toBeNull()
    expect(document.body.textContent).toMatch(/finds the answer in other\.pdf/)
  })

  it("draws one mark per question, and a mark brings its row into view", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await finishTwo()
    const marks = within(await screen.findByRole("list", { name: "One mark per question" })).getAllByRole("button")
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual(["Question 1, found", "Question 2, missed"])
    expect(marks.map((m) => m.textContent)).toEqual(["\u2713", "\u2715"])
    expect(marks[0].className).toContain("bg-kept")
    expect(marks[1].className).toContain("bg-removed")
    expect(marks[1].className).toContain("--removed-mark")
    fireEvent.click(marks[1])
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" })
  })

  it("brings the row into view at once when reduced motion is on", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)", media: q, addEventListener() {}, removeEventListener() {} }))
    await finishTwo()
    const marks = within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    fireEvent.click(marks[1])
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" })
  })

  it("says the verdict in a word and the reason in a sentence, with no hash id", async () => {
    await finishTwo()
    const row = document.querySelector<HTMLElement>('[data-question="b"]')!
    expect(row.textContent).toContain("\u2715 Missed")
    expect(row.querySelector("[data-verdict]")!.className).toContain("text-removed-mark")
    expect(row.textContent).toContain("Not in any of the 3 pieces that came back")
    expect(row.textContent).not.toMatch(/[0-9a-f]{8}/)
    // The question's own id, quietly under it.
    expect(row.querySelector(".font-mono")!.textContent).toBe("b")
    expect(row.textContent).not.toMatch(/checked$/)
    expect(row.querySelector("[data-question-text]")!.className).toContain("text-base")
    expect(document.querySelector<HTMLElement>('[data-question="a"]')!.textContent).toContain("\u2713 Found")
    expect(document.querySelector<HTMLElement>('[data-question="a"]')!.textContent).toContain("Found in the 1st piece, word for word.")
    // After a run the evidence folds away on a phone, since Details shows it.
    expect(document.querySelector<HTMLElement>('[data-question="a"] [data-evidence]')!.className).toContain("hidden md:grid")
    expect(screen.queryByText("result")).toBeNull()
    expect(document.querySelector('[data-question="b"]')!.className).not.toContain("border-l-2")
  })

  it("says how a row changed since the last run, a loss on the removed hue", async () => {
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: "working", byId: { a: score(), b: score() }, totals: totalsOf(2, 2) })
    await finishTwo()
    const change = document.querySelector<HTMLElement>('[data-question="b"] [data-row-change]')!
    expect(change.textContent).toBe("Was found 1st")
    expect(change.className).toContain("text-removed-mark")
    expect(document.querySelector('[data-question="a"] [data-row-change]')).toBeNull()
  })

  it("opens Details in the side sheet: the evidence, then the top three pieces as slips", async () => {
    const hit = (rank: number, id: string, text: string) => ({
      chunk: { id, text, embed_text: null, start_char: 0, end_char: 1, token_count: 1, kind: "text", parent_id: null, level: 0, ordinal: rank + 1, doc_id: "d", heading_path: [], source_element_ids: [], page_span: [1, 1], metadata: {} },
      score: 0.03 - rank / 1000,
      rank,
      prior_rank: null,
      prior_score: null,
      matched_chunk_id: id,
      expansion: "none",
      retriever: "hybrid_rrf",
      component_scores: {},
      highlights: [],
    })
    const r1 = {
      hits: [hit(1, "h1", "First piece."), hit(2, "h2", "Second piece."), hit(3, "h3", "Third piece."), hit(4, "h4", "Fourth piece.")],
      query_id: "q",
      fetch_k: 20,
      total_candidates: 4,
      timings_ms: { search: 3 },
    }
    const { es } = await start({
      artifacts: { r1 },
      // The retrieval result the eval step scored comes by its id in the report.
      result: report([verdict("a"), verdict("b", { score: score({ rank: 2, matched_chunk_id: "h2", returned: 4 }), result_id: "r1" })]),
    })
    es.emit(1, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")

    fireEvent.click(within(document.querySelector<HTMLElement>('[data-question="b"]')!).getByRole("button", { name: "Details" }))
    const open = screen.getByRole("dialog", { name: "How big is a chunk?" })
    expect(within(open).getByText("The evidence")).toBeTruthy()
    expect(within(open).getByText("A chunk should answer one question well.").className).toContain("font-serif")
    expect(within(open).getByText("Expected answer: None given")).toBeTruthy()
    await waitFor(() => expect(within(open).getAllByTestId("passage")).toHaveLength(3))
    expect(within(open).getByText("What came back, top 3 of 4")).toBeTruthy()
    const findings = within(open).getAllByTestId("finding").map((f) => f.textContent)
    expect(findings).toEqual(["1st", "2nd, holds the answer", "3rd"])
    // The swatch names the piece by its place in the chunk set.
    expect(within(open).getAllByRole("img").map((s) => s.getAttribute("aria-label"))).toEqual(["Chunk 3", "Chunk 4", "Chunk 5"])
    // The retrieval facts line is not shown here.
    expect(open.textContent).not.toMatch(/fetch_k|candidates/)
    fireEvent.click(within(open).getByRole("button", { name: "Show all 4" }))
    expect(within(open).getAllByTestId("passage")).toHaveLength(4)
    // A found question has no trace; Escape closes the sheet.
    expect(within(open).queryByTestId("detail-trace")).toBeNull()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("invites a missed row to say why, and shows the trace the server sent, with no request of its own", async () => {
    traced.length = 0
    const served = await finishTwo({ found_at: null, returned: 4 }, { lost_at: "parse", trace: TRACE as never })

    const row = document.querySelector<HTMLElement>('[data-question="b"]')!
    expect(row.querySelector("[data-why]")!.textContent).toBe("Why did this miss?")
    expect(document.querySelector('[data-question="a"] [data-why]')).toBeNull()

    fireEvent.click(row.querySelector("[data-why]")!)
    const sheet = screen.getByRole("dialog", { name: "How big is a chunk?" })
    expect(within(sheet).getByText(/^Lost at Parse\./)).toBeTruthy()
    expect(sheet.querySelector("del[data-part='other']")!.textContent).toBe("column two")
    expect(within(sheet).getByRole("link", { name: "Change Parse on Build" }).getAttribute("href")).toBe(`/build?step=${idOf("parse")}`)
    expect(traced).toHaveLength(0)
    expect(served.urls.some((u) => u.endsWith("/trace"))).toBe(false)
  })

  it("says the last run beside the score, and stores this run with its recipe and the server's totals", async () => {
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: "working", byId: { a: score(), b: score() }, totals: totalsOf(2, 2) })
    await finishTwo()
    expect(screen.getByTestId("summary").textContent).toBe("1 of 2 questions found the answer. The last run found 2 of 2.")
    // An older stored run has no recipe, so the miss is new since the last run.
    expect(screen.getByTestId("score-note").textContent).toBe("The miss is new since the last run.")
    // Each number says what it was when the last run differs.
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)50%was 100%")
    await waitFor(() => expect(readPreviousEvaluation(SOURCE.sha, "working")?.steps?.[0]).toMatchObject({ label: "Parse", transform: "docling", name: "Docling" }))
    expect(typeof readPreviousEvaluation(SOURCE.sha, "working")?.steps?.[0].config).toBe("string")
    expect(readPreviousEvaluation(SOURCE.sha, "working")?.k).toBe(5)
    expect(readPreviousEvaluation(SOURCE.sha, "working")?.totals).toMatchObject({ total: 2, found: 1, hit_rate: 0.5 })
    // Take it home offers these scores only for the same pipeline and the same questions.
    expect(readPreviousEvaluation(SOURCE.sha, "working")?.config).toMatchObject({ index: { parse: { use: "docling" } } })
    expect(JSON.parse(readPreviousEvaluation(SOURCE.sha, "working")!.questions!).map((q: string[]) => q[0])).toEqual(["a", "b"])
  })

  it("compares the numbers only with a last run scored at the same Pieces checked", async () => {
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: "working", byId: { a: score(), b: score() }, totals: totalsOf(2, 2), k: 1 })
    await finishTwo()
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)50%")
    expect(screen.getByTestId("numbers").textContent).not.toContain("was")
  })

  it("warns that the score says nothing when the pipeline makes fewer pieces than the top k", async () => {
    const { es } = await start({ artifacts: { c0: { chunks: [{ id: "a" }, { id: "b" }, { id: "c" }] } } })
    es.emit(1, finished("a", idOf("chunk"), "c0"))
    const warning = await screen.findByTestId("pieces-warning")
    expect(warning.textContent).toBe("This pipeline makes only 3 pieces, so every question finds its answer. The score says nothing here.")
    expect(warning.getAttribute("role")).toBe("status")
  })
})

describe("the pipeline's document", () => {
  /** Answers `GET /api/v2/documents` with no uploads, so a file nobody has reads as missing. */
  function noUploads() {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => (url === "/api/v2/documents" ? Promise.resolve(new Response("[]", { status: 200 })) : base(url, init))),
    )
  }

  it("says the document is missing and disables Evaluate", async () => {
    serve()
    noUploads()
    storeGraph(sampleGraph(registry, { sha: "ef".repeat(32), filename: "NK_Resume.pdf" }))
    render(<Evaluate />)
    expect((await screen.findByTestId("document-note")).textContent).toContain("Pick a document under Documents to run the evaluation.")
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText("Needs a document.")).toBeTruthy()
  })

  it("asks for a document when the pipeline has none, instead of No pipeline to evaluate", async () => {
    serve()
    noUploads()
    savePipeline("No file yet", setConfig(sampleGraph(registry, SOURCE), "source", {}))
    render(<Evaluate />)
    expect((await screen.findByTestId("document-note")).textContent).toBe(
      "Pick a document under Documents to run the evaluation.Pick a document",
    )
    expect(screen.queryByText("No pipeline to evaluate")).toBeNull()
  })
})

describe("a large question set", () => {
  const graph = sampleGraph(registry, SOURCE)
  const step = (question: string, card: string, event: string, extra: Record<string, unknown> = {}) => {
    const name = stepOfCardIn(graph, card)
    return { event, node_id: name, step: name, document: null, question, ...extra }
  }
  const twelve = Array.from({ length: 12 }, (_, i) =>
    question({ id: `q${i}`, question: `Question number ${i}?`, gold_answers: [`Answer number ${i}.`] }),
  )
  const stored = goldSet({
    count: 12,
    set: { version: 1, document: "handbook.pdf", questions: twelve },
    questions: twelve.map((q, i) => ({
      index: i,
      id: q.id,
      question: q.question,
      status: "found",
      golds: [{ gold: q.gold_answers[0], status: "found", document_text: "", closest: "" }],
    })),
  })

  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  async function start(result: EvaluationResult) {
    const served = serve({ stored, result })
    storeGraph(graph)
    render(<Evaluate />)
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    return { es: DrivenEventSource.instances[0], served }
  }

  it("sends every question in one request, and scores them as one evaluation", async () => {
    const { es, served } = await start(report(twelve.map((q) => verdict(q.id))))
    expect(served.evaluations).toHaveLength(1)
    expect(served.evaluations[0].questions.map((q) => q.id)).toEqual(twelve.map((q) => q.id))
    twelve.forEach((q, i) => es.emit(i + 1, { event: "question_finished", question: q.id, number: i + 1, total: 12, found: true, error: null }))
    es.emit(13, { event: "stream_end", status: "finished", ok: true })

    const summary = await screen.findByTestId("summary")
    expect(summary.textContent).toBe("12 of 12 questions found the answer.")
    const marks = within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual(twelve.map((_, i) => `Question ${i + 1}, found`))
    expect(served.evaluations).toHaveLength(1)
  })

  it("stops the run on Cancel, leads with how far it got, and compares the part with nothing", async () => {
    // A full last run in this tab: a stopped run must not be measured against it.
    const last = { sourceSha: SOURCE.sha, pipelineKey: "working", byId: { q0: score({ hit: false, rank: null }) }, totals: totalsOf(12, 12) }
    storePreviousEvaluation(last)
    const missed = score({ hit: false, rank: null, matched_chunk_id: "", match: "none", returned: 3 })
    const { es, served } = await start(report([verdict("q0"), verdict("q1", { score: missed })], { cancelled: true }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(served.cancelled).toEqual(["e1"]))
    es.emit(1, step("q0", "retrieve", "node_finished", { artifact_id: "r0", cache_hit: false, duration_ms: 1 }))
    es.emit(2, { event: "question_finished", question: "q0", number: 1, total: 12, found: true, error: null })
    es.emit(3, step("q1", "retrieve", "node_finished", { artifact_id: "r1", cache_hit: false, duration_ms: 1 }))
    es.emit(4, { event: "question_finished", question: "q1", number: 2, total: 12, found: false, error: null })
    // The third question had started its search when the cancel landed.
    es.emit(5, step("q2", "retrieve", "node_started", { transform: "x", artifact_id: "r2" }))
    es.emit(6, { event: "stream_end", status: "cancelled", ok: false })
    await waitFor(() => expect(screen.getByRole("button", { name: "Evaluate again" })).toBeTruthy())
    expect((await screen.findByTestId("summary")).textContent).toBe(
      "Stopped after 2 of 12 questions. 1 of the 2 questions scored before the stop found the answer.",
    )
    expect(screen.queryByTestId("score-note")).toBeNull()
    expect(screen.getByTestId("numbers").textContent).not.toContain("was")
    expect(document.querySelector('[data-question="q0"] [data-row-change]')).toBeNull()
    // The questions it never scored read Not run, not running or waiting.
    const marks = within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([
      "Question 1, found",
      "Question 2, missed",
      ...twelve.slice(2).map((_, i) => `Question ${i + 3}, not run`),
    ])
    // Two searches ran before the stop.
    expect(screen.getByTestId("run-summary").textContent).toContain("2 searches, ran now.")
    expect(served.evaluations).toHaveLength(1)
    // A stopped run is not kept as the last run to compare against.
    expect(readPreviousEvaluation(SOURCE.sha, "working")).toEqual(last)
  })

  it("says it stopped before any question was scored, with no score and no numbers", async () => {
    const { es } = await start(report([], { cancelled: true }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    es.emit(1, { event: "stream_end", status: "cancelled", ok: false })
    expect((await screen.findByTestId("stopped")).textContent).toBe("Stopped before any question was scored.")
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByTestId("numbers")).toBeNull()
    expect(document.body.textContent).not.toContain("0 of 0")
    expect(document.body.textContent).not.toContain("0 searches")
  })
})

// A cold first render can take more than the default five seconds on a busy machine.
describe("Best so far", { timeout: 15000 }, () => {
  const graph = sampleGraph(registry, SOURCE)
  const KEYED = { questions_fingerprint: "fp", document_shas: [SOURCE.sha] }
  const found = (id: string, text: string) => verdict(id, { question: text })
  const missed = (id: string, text: string) => verdict(id, { question: text, score: score({ hit: false, rank: null, matched_chunk_id: "", match: "none" }) })
  const A = "What are the two steps?"
  const B = "How big is a chunk?"
  /** The best pipeline: the sample's, with another chunk size, so loading it is visible. */
  const chunkId = graph.nodes.find((n) => n.stage === "chunk")!.id
  const bestGraph = setConfig(graph, chunkId, { ...graph.nodes.find((n) => n.id === chunkId)!.config, chunk_size: 321 })
  const bestPipeline = () => {
    const c = graphToConfig(bestGraph)
    if (!c.ok) throw new Error(c.problem)
    return c.pipeline
  }
  const seed = (r: EvaluationResult, name = "Best one") => afterRun(r, name, bestPipeline())

  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  async function runOnce(result: EvaluationResult, navigate = vi.fn()) {
    serve({ result })
    storeGraph(graph)
    render(<Evaluate navigate={navigate} />)
    // A cold first render can take more than the default second on a busy machine.
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 })
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    DrivenEventSource.instances[0].emit(1, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary", {}, { timeout: 4000 })
    return navigate
  }

  it("makes the first run with these questions the best so far", async () => {
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    const line = await screen.findByTestId("best-so-far")
    expect(line.textContent).toContain("Your first run with these questions, so it is your best so far.")
    expect(screen.getByTestId("best-note").textContent).toContain('Only questions decide "better" and "worse"')
    expect(readBest(bestKey(report([], KEYED))!)!.found).toBe(1)
  })

  it("says a worse run, names the lost questions, and offers the best pipeline", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    const line = await screen.findByTestId("best-so-far")
    expect(line.textContent).toContain("1 fewer found than your best.")
    expect(line.textContent).toMatch(/Best so far: 2 of 2, MRR 1\.00, with Best one, today at \d\d:\d\d\./)
    expect(within(line).getByRole("list", { name: "Lost since your best" }).textContent).toBe(`lost${B}`)
    expect(within(line).getByRole("button", { name: "Load the best pipeline" })).toBeTruthy()
    expect(within(line).getByRole("button", { name: "Compare the two" })).toBeTruthy()
    // The best stays the best.
    expect(readBest(bestKey(report([], KEYED))!)!.name).toBe("Best one")
  })

  it("says a better run, names the won questions, and makes it the best", async () => {
    seed(report([found("a", A), missed("b", B)], { ...KEYED, mrr: 0.5 }))
    await runOnce(report([found("a", A), found("b", B)], KEYED))
    const line = await screen.findByTestId("best-so-far")
    expect(line.textContent).toContain("New best. 1 more found than the last best (1 of 2, MRR 0.50). This pipeline is now your best for these questions.")
    expect(within(line).getByRole("list", { name: "Won since your best" }).textContent).toBe(`won${B}`)
    expect(readBest(bestKey(report([], KEYED))!)!.found).toBe(2)
  })

  it("says an equal run in a short line and keeps the best", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    await runOnce(report([found("a", A), found("b", B)], KEYED))
    expect((await screen.findByTestId("best-so-far")).textContent).toBe("Same as your best: 2 of 2.")
    expect(readBest(bestKey(report([], KEYED))!)!.name).toBe("Best one")
  })

  it("does not compare with the best of another question set or another Pieces checked", async () => {
    seed(report([found("a", A), found("b", B)], { ...KEYED, questions_fingerprint: "another" }))
    seed(report([found("a", A), found("b", B)], { ...KEYED, top_k: 3 }))
    await runOnce(report([missed("a", A), missed("b", B)], KEYED))
    expect((await screen.findByTestId("best-so-far")).textContent).toContain("Your first run with these questions")
  })

  it("loads the best pipeline onto Build", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    const navigate = await runOnce(report([found("a", A), missed("b", B)], KEYED))
    fireEvent.click(await screen.findByRole("button", { name: "Load the best pipeline" }))
    expect(navigate).toHaveBeenCalledWith("/build?from=evaluate")
    const loaded = graphToConfig(readStoredGraph(registry))
    expect(loaded.ok && loaded.pipeline.config).toEqual(bestPipeline().config)
  })

  it("opens Compare with the best pipeline loaded", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    const navigate = await runOnce(report([found("a", A), missed("b", B)], KEYED))
    fireEvent.click(await screen.findByRole("button", { name: "Compare the two" }))
    expect(navigate).toHaveBeenCalledWith("/compare")
    const loaded = graphToConfig(readStoredGraph(registry))
    expect(loaded.ok && loaded.pipeline.config).toEqual(bestPipeline().config)
  })

  it("forgets the best", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    const forget = await screen.findByRole("button", { name: "Forget best" })
    // On the amber box the link takes the box's text colour, not the green link colour.
    expect(forget.className).toContain("text-current")
    expect(forget.className).not.toContain("text-primary")
    fireEvent.click(forget)
    expect(readBest(bestKey(report([], KEYED))!)).toBeNull()
    expect(screen.getByTestId("best-so-far").textContent).toBe("Best forgotten. Your next run with these questions becomes the best.")
  })

  it("reads only the headline out, from a live region that is always there", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    // Mounted, and empty, before any run.
    const empty = { live: "" as string | null }
    const seen = new MutationObserver(() => {
      const live = document.querySelector('[data-testid="best-live"]')
      if (live && empty.live === "") empty.live = live.getAttribute("aria-live") === "polite" && live.textContent === "" ? "ok" : "bad"
    })
    seen.observe(document.body, { childList: true, subtree: true })
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    seen.disconnect()
    expect(empty.live).toBe("ok")
    await waitFor(() => expect(screen.getByTestId("best-live").textContent).toBe("1 fewer found than your best."))
    expect(screen.getByTestId("best-so-far").getAttribute("aria-live")).toBeNull()
  })

  it("moves focus to the live region when Forget best takes its button away", async () => {
    seed(report([found("a", A), found("b", B)], KEYED))
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    const forget = await screen.findByRole("button", { name: "Forget best" })
    forget.focus()
    fireEvent.click(forget)
    const live = screen.getByTestId("best-live")
    expect(live.textContent).toBe("Best forgotten.")
    await waitFor(() => expect(document.activeElement).toBe(live))
  })

  it("says why the best pipeline cannot open here, instead of doing nothing", async () => {
    const p = bestPipeline()
    afterRun(report([found("a", A), found("b", B)], KEYED), "Old one", { ...p, config: { ...p.config, index: { ...p.config.index, chunk: { use: "nope" } } } })
    const navigate = await runOnce(report([found("a", A), missed("b", B)], KEYED))
    fireEvent.click(await screen.findByRole("button", { name: "Load the best pipeline" }))
    expect(navigate).not.toHaveBeenCalled()
    expect((await screen.findByTestId("best-problem")).textContent).toBe("Old one cannot open here. It uses a step this server does not have: nope.")
  })

  it("keeps Evaluate working when localStorage throws", async () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (k === BEST_KEY) throw new Error("blocked")
      return get.call(this, k)
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === BEST_KEY) throw new Error("blocked")
      return set.call(this, k, v)
    })
    await runOnce(report([found("a", A), missed("b", B)], KEYED))
    expect(screen.getByTestId("summary").textContent).toBe("1 of 2 questions found the answer.")
    expect((await screen.findByTestId("best-so-far")).textContent).toContain("Your first run with these questions")
    vi.restoreAllMocks()
  })

  it("says nothing about a best when the server sends no fingerprint", async () => {
    await runOnce(report([found("a", A), missed("b", B)]))
    expect(screen.queryByTestId("best-so-far")).toBeNull()
  })
})
