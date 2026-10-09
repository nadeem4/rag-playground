import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import liveRegistry from "@/api/fixtures/registry.json"
import type { GoldQuestion, QuestionSetUpload, Registry, SampleQuestion } from "@/api/types"
import type { EvalSummary } from "@/state/evaluate"
import { readPreviousEvaluation, storePreviousEvaluation } from "@/state/evaluate"
import { chooseDocument, resetDocumentForTests } from "@/state/document"
import { resetStoredGraphForTests, sampleGraph, setConfig, setTransform, storeGraph, type PipelineGraph } from "@/state/graph"
import { resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"
import { choose, optionNames, optionOf } from "@/components/ui/pickerTesting"

import { Evaluate } from "./Evaluate"

const registry = liveRegistry as unknown as Registry
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
const OTHER_SHA = "ab".repeat(32)

const QUESTIONS: SampleQuestion[] = [
  { id: "a", question: "What are the two steps?", gold_answer: "It answers in two steps." },
  { id: "b", question: "How big is a chunk?", gold_answer: "A chunk should answer one question well." },
]

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
 * `stored` is what `GET /api/sources/{sha}/questions` has, null for no set.
 */
/** One `POST /api/sweeps` body, as the test needs to inspect it. */
interface RecordedSweep {
  graph: PipelineGraph
  node_id: string
  variants: unknown[]
  through: string
}

/** Every POST /api/trace body, and what it answers. */
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
}: {
  reg?: unknown
  sampleSha?: string | null
  stored?: QuestionSetUpload | null
  upload?: QuestionSetUpload | { status: number }
  demo?: boolean
  /** Artifact payloads by id, served at `/api/artifacts/{id}/payload`. */
  artifacts?: Record<string, unknown>
} = {}): { sweeps: RecordedSweep[] } {
  const sweeps: RecordedSweep[] = []
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sweeps" && init?.method === "POST") {
        sweeps.push(JSON.parse(String(init.body)) as RecordedSweep)
        return ok({ run_id: "r1" })
      }
      if (url === "/api/trace" && init?.method === "POST") {
        traced.push(JSON.parse(String(init.body)))
        return ok(TRACE)
      }
      const artifact = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (artifact) return artifact[1] in artifacts ? ok(artifacts[artifact[1]]) : missing()
      if (url === "/api/registry") return ok(reg)
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
      if (url.endsWith("/questions")) {
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
  return { sweeps }
}

/** Serves the default registry, stores the sample graph for `SOURCE`, and renders Evaluate. */
function setup(): { sweeps: RecordedSweep[] } {
  const { sweeps } = serve()
  storeGraph(sampleGraph(registry, SOURCE))
  render(<Evaluate />)
  return { sweeps }
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
  resetAppSettingsForTests()
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
  it("sends you to Build when nothing has been built", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByText("No pipeline to evaluate")).toBeTruthy())
    expect(screen.queryByTestId("document-note")).toBeNull()
    expect(screen.getByRole("link", { name: "Go to Build" }).getAttribute("href")).toBe("/build")
  })

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
    expect(within(sheet).getByText("Mean reciprocal rank")).toBeTruthy()
    expect(within(sheet).getByText("(1 + 1/2 + 0 + 1 + 1/3 + 0) / 6 = 0.47")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("says what Pieces checked means behind its i button, and closes it on Escape", async () => {
    setup()
    const info = await screen.findByRole("button", { name: "What Pieces checked means" })
    expect(info.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(info)
    expect(info.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByRole("region", { name: "What Pieces checked means" }).textContent).toMatch(/how many from the top are checked/)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("region", { name: "What Pieces checked means" })).toBeNull()
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
        "2 questions from the sample, A primer on chunking. Found means the evidence is in the top 5 pieces.",
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
    const change = within(screen.getByTestId("recipe-line")).getByRole("link", { name: "Change a step on Build" })
    expect(change.getAttribute("href")).toBe("/build")
    expect(change.className).toContain("inline-flex")
    const search = screen.getByTestId("search-line").textContent!
    expect(search).toMatch(/^Search side:/)
    expect(search).toMatch(/Rewrite: None/)
    expect(search).toMatch(/Retrieve: Hybrid \(RRF\), hybrid_rrf, returns \d+/)
    expect(search).toMatch(/Rerank: None/)
    expect(within(screen.getByTestId("search-line")).getByRole("link", { name: "Change the search settings" }).getAttribute("href")).toBe("/build")
  })

  it("uses only spacing steps the theme defines (0, 1, 2, 3, 4, 6, 8), since any other step compiles to nothing", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Evaluate.tsx", "components/evaluate/QuestionSetPanel.tsx", "components/evaluate/EvalMetrics.tsx"]
    const offScale = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(offScale)
  })

  it("breaks the filename only where it cannot fit", async () => {
    setup()
    const header = await screen.findByTestId("evaluate-header")
    const name = within(header).getByText("chunking-primer.pdf")
    expect(name.className).toContain("break-words")
    expect(name.className).not.toContain("break-all")
  })

  it("uses no sm: class in its files, since the theme has no sm breakpoint", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Evaluate.tsx", "components/evaluate/QuestionSetPanel.tsx", "components/evaluate/EvalMetrics.tsx"]
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
        if (url === "/api/registry") return ok(liveRegistry)
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
        "2 questions from the sample, A primer on chunking. Found means the evidence is in the top 5 pieces.",
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
    expect(note.textContent).toMatch(/does not store question sets/)
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

describe("Evaluate picks a pipeline", () => {
  const picker = () => screen.getByRole("button", { name: /^Pipeline/ }) as HTMLButtonElement
  const picked = () => picker().getAttribute("data-picked")

  it("lists the pipeline on Build and every saved pipeline, defaulting to the one current on Build", async () => {
    // The working copy on Build is this pipeline, unedited, so it is the default (I1).
    const graph = setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry)
    const saved = savePipeline("Token chunks", graph)!.saved
    serve()
    storeGraph(graph)
    render(<Evaluate />)
    await screen.findByRole("button", { name: /^Pipeline/ })
    // Saved pipelines first, then the one on Build, as the approved design lists them.
    expect(optionNames(picker())).toEqual(["Token chunks", "The pipeline on Build"])
    expect(picked()).toBe(saved.id)
    // Each pipeline says its steps in one line, closed and open.
    expect(picker().textContent).toContain("Docling")
    expect(optionOf(picker(), "Token chunks").textContent).toContain("Fixed token count")
    // The name and the filename sit in separate nodes (the filename in its own <span>), so this
    // reads the whole line rather than getByText, which cannot match text split across elements.
    expect(document.body.textContent).toMatch(/How often Token chunks finds the answer in chunking-primer\.pdf\./)
  })

  it("scores the chosen pipeline's graph", async () => {
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    setCurrentId(null)
    const p = setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picked()).toBe("")
    choose(picker(), "Token chunks")
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(p.sweeps.length).toBe(1))
    const chunk = p.sweeps[0].graph.nodes.find((n) => n.stage === "chunk")
    expect(chunk?.transform).toBe("token_based")
  })

  it("does not borrow a previous score from another pipeline", async () => {
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: "working", byId: {}, summary: { total: 10, hits: 10, averageRank: null } as EvalSummary })
    const saved = savePipeline("Token chunks", sampleGraph(registry, SOURCE))!.saved
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picked()).toBe(saved.id)
    expect(screen.queryByTestId("previous")).toBeNull()
  })

  it("scores what is on Build when the current pipeline has been edited there (I1)", async () => {
    // A is current on Build, but Build shows it edited: the working copy has recursive chunks.
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    const p = setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picked()).toBe("")
    expect(document.body.textContent).toMatch(/How often Token chunks \(edited\) finds the answer in chunking-primer\.pdf\./)
    expect(optionOf(picker(), "The pipeline on Build").textContent).toContain("Edited since saved")
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(p.sweeps.length).toBe(1))
    expect(p.sweeps[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("recursive_character")
  })

  it("compares an edited pipeline against its own last score, so the first edit still says what it was (I1)", async () => {
    const saved = savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))!.saved
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: saved.id, byId: {}, summary: { total: 2, hits: 1, averageRank: null } as EvalSummary })
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picked()).toBe("")
    expect((await screen.findByTestId("previous")).textContent).toMatch(/found 1 of 2/)
  })

  it("scores a picked saved pipeline on the bar's document", async () => {
    // The saved pipeline was built on another file; the bar (the working copy) is on SOURCE.
    const other = setConfig(setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry), "source", { sha: OTHER_SHA, filename: "other.pdf" })
    const savedId = savePipeline("Token chunks", other)!.saved.id
    setCurrentId(null)
    const { sweeps } = setup()
    choose(await screen.findByRole("button", { name: /^Pipeline/ }), "Token chunks")
    expect(picked()).toBe(savedId)
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(sweeps).toHaveLength(1))
    expect(sweeps[0].graph.nodes.find((n) => n.stage === "source")!.config.sha).toBe(SOURCE.sha)
    expect(sweeps[0].graph.nodes.find((n) => n.stage === "chunk")!.transform).toBe("token_based")
    expect(document.body.textContent).toMatch(/How often Token chunks finds the answer in chunking-primer\.pdf\./)
  })

  it("keeps the picker's own element, and so its focus, when the pipeline changes (Task 3 review)", async () => {
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    setCurrentId(null)
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    const before = picker()
    before.focus()
    choose(before, "Token chunks")
    await waitFor(() => expect(document.body.textContent).toMatch(/How often Token chunks finds/))
    expect(picker()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it("lists a saved pipeline this server cannot run as not usable, and never defaults to it (M7)", async () => {
    const graph = sampleGraph(registry, SOURCE)
    savePipeline("Semantic", { ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) })
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picked()).toBe("")
    const option = optionOf(picker(), "Semantic")
    expect(option.textContent).toContain("Cannot run")
    expect(option.getAttribute("aria-disabled")).toBe("true")
  })

  it("holds the pipeline still while an evaluation runs (M8)", async () => {
    setup()
    await screen.findByRole("button", { name: /^Pipeline/ })
    expect(picker().disabled).toBe(false)
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(picker().disabled).toBe(true))
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

describe("while and after scoring", () => {
  const graph = sampleGraph(registry, SOURCE)
  const idOf = (stage: string) => graph.nodes.find((n) => n.stage === stage)!.id
  const evalOut = (over: Record<string, unknown>) => ({
    kind: "eval",
    payload: {
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
    },
  })

  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  async function start(artifacts: Record<string, unknown>) {
    serve({ artifacts })
    storeGraph(graph)
    render(<Evaluate />)
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    return DrivenEventSource.instances[0]
  }

  it("while the busy demo makes the run wait, says so instead of a question count", async () => {
    const es = await start({ o0: evalOut({}), o1: evalOut({}) })
    es.emit(0, { event: "queued", ahead: 0 })
    await waitFor(() => expect(document.body.textContent).toContain("The demo is busy with other learners. Your run starts in a moment."))
    expect(document.body.textContent).not.toContain("scoring question")
    es.emit(1, { event: "unqueued" })
    await waitFor(() => expect(screen.getByTestId("progress-line").textContent).toBe("Searching and scoring question 1 of 2."))
  })

  it("says which question it is scoring while busy, and shows the summary once done", async () => {
    const es = await start({
      o0: evalOut({}),
      o1: evalOut({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: 7, total_candidates: 12 }),
    })
    await waitFor(() => expect(screen.getByTestId("progress-line").textContent).toBe("Searching and scoring question 1 of 2."))
    expect(screen.getByTestId("index-line").textContent).toBe("Waiting to start")
    expect(screen.getByRole("progressbar", { name: "Questions scored" }).getAttribute("aria-valuemax")).toBe("2")
    // Every mark is drawn at once, and waits until its row lands.
    const waiting = within(screen.getByRole("list", { name: "One mark per question" })).getAllByRole("button")
    expect(waiting.map((m) => m.getAttribute("aria-label"))).toEqual(["Question 1, waiting", "Question 2, waiting"])
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByTestId("numbers")).toBeNull()

    const useCase = idOf("use_case")
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: useCase, artifact_id: "o0", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_finished", node_id: useCase, artifact_id: "o1", cache_hit: false, duration_ms: 1 })
    es.emit(5, { event: "stream_end", status: "finished", ok: true })

    const summary = await screen.findByTestId("summary")
    expect(summary.textContent).toBe("1 of 2 questions found the answer.")
    expect(summary.className).toContain("text-[1.375rem]")
    expect(summary.className).toContain("max-w-[52ch]")
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)50%")
    expect(screen.queryByTestId("score-note")).toBeNull()
    expect(summary.className).not.toContain("font-mono")
    expect(summary.querySelector("span.font-mono")).not.toBeNull()
    expect(screen.queryByTestId("progress")).toBeNull()
    expect(document.body.textContent).toContain("Found 7th, below the 5 pieces checked.")
    // The verdict and the reason in sans; mono only on the digits.
    for (const row of document.querySelectorAll<HTMLElement>("li[data-question]")) {
      const verdict = row.querySelector<HTMLElement>("[data-verdict]")!
      expect(verdict.className).toContain("font-sans")
      expect(verdict.className).toContain("font-semibold")
      expect(verdict.querySelector(".font-mono")).toBeNull()
      const reason = row.querySelector<HTMLElement>("[data-reason]")!
      expect(reason.className).not.toContain("font-mono")
      expect([...reason.querySelectorAll(".font-mono")].every((m) => /^[\d,.]+$/.test(m.textContent ?? ""))).toBe(true)
      expect(reason.querySelector(".font-mono")).not.toBeNull()
    }
  })

  it("keeps saying the k that was scored when Pieces checked changes after the run", async () => {
    const pieces = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}` }))
    const es = await start({
      c7: { chunks: pieces },
      o0: evalOut({}),
      o1: evalOut({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: 7, total_candidates: 12 }),
    })
    const useCase = idOf("use_case")
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: idOf("chunk"), artifact_id: "c7", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "node_finished", node_id: useCase, artifact_id: "o0", cache_hit: false, duration_ms: 1 })
    es.emit(4, { event: "variant_started", index: 1, variant: {} })
    es.emit(5, { event: "node_finished", node_id: useCase, artifact_id: "o1", cache_hit: false, duration_ms: 1 })
    es.emit(6, { event: "stream_end", status: "finished", ok: true })
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

  let finished = 0

  /** Runs the two questions to the end: a found one and a missed one. */
  async function finishTwo(missed: Record<string, unknown> = {}) {
    // Payloads are cached by artifact id, so each run gets ids of its own.
    const [a0, a1] = [`f${++finished}a`, `f${finished}b`]
    const es = await start({ [a0]: evalOut({}), [a1]: evalOut({ hit: false, rank: null, matched_chunk_id: "", match: "none", returned: 3, ...missed }) })
    const useCase = idOf("use_case")
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: useCase, artifact_id: a0, cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_finished", node_id: useCase, artifact_id: a1, cache_hit: false, duration_ms: 1 })
    es.emit(5, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")
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
    storePreviousEvaluation({
      sourceSha: SOURCE.sha,
      pipelineKey: "working",
      byId: { a: evalOut({}).payload as never, b: evalOut({}).payload as never },
      summary: { hits: 2, total: 2, averageRank: 1 },
    })
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
    const es = await start({
      s0: evalOut({}),
      s1: evalOut({ rank: 2, matched_chunk_id: "h2", returned: 4 }),
      r1,
    })
    const useCase = idOf("use_case")
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: useCase, artifact_id: "s0", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_finished", node_id: idOf("retrieve"), artifact_id: "r1", cache_hit: false, duration_ms: 1 })
    es.emit(5, { event: "node_finished", node_id: useCase, artifact_id: "s1", cache_hit: false, duration_ms: 1 })
    es.emit(6, { event: "stream_end", status: "finished", ok: true })
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

  it("invites a missed row to say why, and traces it in the side sheet once asked", async () => {
    traced.length = 0
    const es = await start({
      // Ids of their own: payloads are cached by id across tests.
      why0: evalOut({}),
      why1: evalOut({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: null, returned: 4 }),
    })
    const steps = graph.nodes.filter((n) => ["parse", "clean", "chunk", "retrieve", "rerank"].includes(n.stage))
    let id = 1
    for (const index of [0, 1]) {
      es.emit(id++, { event: "variant_started", index, variant: {} })
      for (const n of steps) es.emit(id++, { event: "node_finished", node_id: n.id, artifact_id: `${n.stage}-${index}`, cache_hit: false, duration_ms: 1 })
      es.emit(id++, { event: "node_finished", node_id: idOf("use_case"), artifact_id: `why${index}`, cache_hit: false, duration_ms: 1 })
    }
    es.emit(id++, { event: "stream_end", status: "finished", ok: true })
    await screen.findByTestId("summary")

    const row = document.querySelector<HTMLElement>('[data-question="b"]')!
    expect(row.querySelector("[data-why]")!.textContent).toBe("Why did this miss?")
    expect(document.querySelector('[data-question="a"] [data-why]')).toBeNull()
    expect(traced).toHaveLength(0)

    fireEvent.click(row.querySelector("[data-why]")!)
    const sheet = screen.getByRole("dialog", { name: "How big is a chunk?" })
    await waitFor(() => expect(within(sheet).getByText(/^Lost at Parse\./)).toBeTruthy())
    expect(traced).toHaveLength(1)
    expect(traced[0]).toMatchObject({ parse: { id: "parse-1" }, chunk: "chunk-1", retrieve: "retrieve-1", top_k: 5 })
    expect(sheet.querySelector("del[data-part='other']")!.textContent).toBe("column two")
    expect(within(sheet).getByRole("link", { name: "Change Parse on Build" }).getAttribute("href")).toBe(`/build?step=${idOf("parse")}`)
  })

  it("says the last run beside the score, and stores this run with its recipe", async () => {
    storePreviousEvaluation({
      sourceSha: SOURCE.sha,
      pipelineKey: "working",
      byId: { a: evalOut({}).payload as never, b: evalOut({}).payload as never },
      summary: { hits: 2, total: 2, averageRank: 1 },
    })
    await finishTwo()
    expect(screen.getByTestId("summary").textContent).toBe("1 of 2 questions found the answer. The last run found 2 of 2.")
    // An older stored run has no recipe, so the miss is new since the last run.
    expect(screen.getByTestId("score-note").textContent).toBe("The miss is new since the last run.")
    // Each number says what it was when the last run differs.
    expect(screen.getByTestId("numbers").textContent).toContain("Hit rate (Hit@5)50%was 100%")
    await waitFor(() => expect(readPreviousEvaluation(SOURCE.sha, "working")?.steps?.[0]).toMatchObject({ label: "Parse", transform: "docling", name: "Docling" }))
    expect(typeof readPreviousEvaluation(SOURCE.sha, "working")?.steps?.[0].config).toBe("string")
    expect(readPreviousEvaluation(SOURCE.sha, "working")?.k).toBe(5)
  })

  it("warns that the score says nothing when the pipeline makes fewer pieces than the top k", async () => {
    const es = await start({ c0: { chunks: [{ id: "a" }, { id: "b" }, { id: "c" }] } })
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: idOf("chunk"), artifact_id: "c0", cache_hit: false, duration_ms: 1 })
    const warning = await screen.findByTestId("pieces-warning")
    expect(warning.textContent).toBe("This pipeline makes only 3 pieces, so every question finds its answer. The score says nothing here.")
    expect(warning.getAttribute("role")).toBe("status")
  })
})

describe("the document in the bar", () => {
  /** Answers `GET /api/sources` with no uploads, so a file nobody has reads as missing. */
  function noUploads() {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => (url === "/api/sources" ? Promise.resolve(new Response("[]", { status: 200 })) : base(url, init))),
    )
  }

  it("says the document is missing and disables Evaluate", async () => {
    serve()
    noUploads()
    storeGraph(sampleGraph(registry, { sha: "ef".repeat(32), filename: "NK_Resume.pdf" }))
    render(<Evaluate />)
    expect((await screen.findByTestId("document-note")).textContent).toContain("Pick a document in the bar above to run the evaluation.")
    await waitFor(() => expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText("Needs a document.")).toBeTruthy()
  })

  it("asks for a document when the pipeline has none, instead of No pipeline to evaluate", async () => {
    serve()
    noUploads()
    storeGraph(setConfig(sampleGraph(registry, SOURCE), "source", {}))
    render(<Evaluate />)
    expect((await screen.findByTestId("document-note")).textContent).toBe(
      "Pick a document in the bar above to run the evaluation.Pick a document",
    )
    expect(screen.queryByText("No pipeline to evaluate")).toBeNull()
  })
})
