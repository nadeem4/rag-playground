import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import liveRegistry from "@/api/fixtures/registry.json"
import type { GoldQuestion, QuestionSetUpload, Registry, SampleQuestion } from "@/api/types"
import type { EvalSummary } from "@/state/evaluate"
import { storePreviousEvaluation } from "@/state/evaluate"
import { sampleGraph, setTransform, storeGraph, type PipelineGraph } from "@/state/graph"
import { readPipelines, resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"

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
        return stored ? ok(stored) : missing()
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
    expect(text()).toMatch(/Parse\s*docling/)
    expect(text()).toMatch(/Chunk\s*recursive_character/)
    expect(text()).toMatch(/Retrieve\s*hybrid_rrf/)
    expect(screen.getByText("Nothing scored yet")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Run evaluation" })).toBeTruthy()
    expect(screen.getByLabelText("Top k").getAttribute("value")).toBe("5")
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
    await waitFor(() => expect(screen.getByTestId("question-set").textContent).toMatch(/2 questions/))
    // F4: the title is capitalised, so it does not sit mid-sentence after "Scoring".
    expect(screen.getByTestId("question-set").textContent).toMatch(/Scoring the questions for A primer on chunking, 2 questions\./)
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
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("No question set yet"))
  })

  it("uses the set stored against the document, and asks its questions instead of the sample's", async () => {
    serve({ stored: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv"))
    expect(screen.getByTestId("question-set").textContent).toMatch(/2 questions/)
    expect(screen.getByRole("button", { name: "Remove this set" })).toBeTruthy()
    expect(screen.queryByTestId("set-mismatch")).toBeNull()
  })

  it("warns, and offers the removal, when the stored set was uploaded for another document", async () => {
    serve({ stored: goldSet({ sha: OTHER_SHA }) })
    render(<Evaluate />)
    const warning = await screen.findByTestId("set-mismatch", {}, { timeout: 4000 })
    expect(warning.textContent).toMatch(/uploaded for a different document/)
    expect(warning.querySelector("button")!.textContent).toBe("Remove this set")
  })

  it("goes back to the sample set when the uploaded one is removed", async () => {
    serve({ stored: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv"))
    fireEvent.click(screen.getByRole("button", { name: "Remove this set" }))
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("A primer on chunking"))
  })

  it("says an uploaded set lives in this browser tab when the server would not keep it", async () => {
    serve({ upload: goldSet({ stored: false }) })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
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
    const note = await screen.findByTestId("demo-note", {}, { timeout: 4000 })
    expect(note.textContent).toMatch(/does not store question sets/)
    expect(screen.getByRole("link", { name: "Run the playground locally" })).toBeTruthy()
  })

  it("explains itself when the server refuses the upload outright", async () => {
    serve({ upload: { status: 403 } })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
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
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")

    const report = await screen.findByTestId("upload-report", {}, { timeout: 4000 })
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
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")
    await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    expect(screen.getByTestId("upload-report")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})

describe("Evaluate picks a pipeline", () => {
  const picker = () => screen.getByRole("combobox", { name: "Pipeline" }) as HTMLSelectElement

  it("lists the pipeline on Build and every saved pipeline, defaulting to the one current on Build", async () => {
    // The working copy on Build is this pipeline, unedited, so it is the default (I1).
    const graph = setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry)
    const saved = savePipeline("Token chunks", graph)!.saved
    serve()
    storeGraph(graph)
    render(<Evaluate />)
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect([...picker().options].map((o) => o.textContent)).toEqual(["The pipeline on Build", "Token chunks"])
    expect(picker().value).toBe(saved.id)
    // The name and the filename sit in separate nodes (the filename in its own <span>), so this
    // reads the whole line rather than getByText, which cannot match text split across elements.
    expect(document.body.textContent).toMatch(/Token chunks, over chunking-primer\.pdf/)
  })

  it("scores the chosen pipeline's graph", async () => {
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    setCurrentId(null)
    const p = setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().value).toBe("")
    fireEvent.change(picker(), { target: { value: readPipelines()[0].id } })
    await waitFor(() => expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }))
    await waitFor(() => expect(p.sweeps.length).toBe(1))
    const chunk = p.sweeps[0].graph.nodes.find((n) => n.stage === "chunk")
    expect(chunk?.transform).toBe("token_based")
  })

  it("does not borrow a previous score from another pipeline", async () => {
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: "working", byId: {}, summary: { total: 10, hits: 10, averageRank: null } as EvalSummary })
    const saved = savePipeline("Token chunks", sampleGraph(registry, SOURCE))!.saved
    setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().value).toBe(saved.id)
    expect(screen.queryByTestId("previous")).toBeNull()
  })

  it("scores what is on Build when the current pipeline has been edited there (I1)", async () => {
    // A is current on Build, but Build shows it edited: the working copy has recursive chunks.
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    const p = setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().value).toBe("")
    expect(document.body.textContent).toMatch(/Token chunks \(edited\), over chunking-primer\.pdf/)
    await waitFor(() => expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }))
    await waitFor(() => expect(p.sweeps.length).toBe(1))
    expect(p.sweeps[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("recursive_character")
  })

  it("compares an edited pipeline against its own last score, so the first edit still says what it was (I1)", async () => {
    const saved = savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))!.saved
    storePreviousEvaluation({ sourceSha: SOURCE.sha, pipelineKey: saved.id, byId: {}, summary: { total: 2, hits: 1, averageRank: null } as EvalSummary })
    setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().value).toBe("")
    expect((await screen.findByTestId("previous")).textContent).toMatch(/found 1 of 2/)
  })

  it("keeps the picker's own element, and so its focus, when the pipeline changes (Task 3 review)", async () => {
    savePipeline("Token chunks", setTransform(sampleGraph(registry, SOURCE), "chunk", "token_based", registry))
    setCurrentId(null)
    setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    const before = picker()
    before.focus()
    fireEvent.change(before, { target: { value: readPipelines()[0].id } })
    await waitFor(() => expect(document.body.textContent).toMatch(/Token chunks, over/))
    expect(picker()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it("lists a saved pipeline this server cannot run as not usable, and never defaults to it (M7)", async () => {
    const graph = sampleGraph(registry, SOURCE)
    savePipeline("Semantic", { ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) })
    setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().value).toBe("")
    const option = [...picker().options].find((o) => o.textContent === "Semantic (not usable here)")
    expect(option?.disabled).toBe(true)
  })

  it("holds the pipeline still while an evaluation runs (M8)", async () => {
    setup()
    await screen.findByRole("combobox", { name: "Pipeline" })
    expect(picker().disabled).toBe(false)
    await waitFor(() => expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }))
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
    await waitFor(() => expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    return DrivenEventSource.instances[0]
  }

  it("says which question it is scoring while busy, and shows the summary once done", async () => {
    const es = await start({
      o0: evalOut({}),
      o1: evalOut({ hit: false, rank: null, matched_chunk_id: "", match: "none", found_at: 7, total_candidates: 12 }),
    })
    await waitFor(() => expect(document.body.textContent).toContain("Scoring question 1 of 2."))
    expect(screen.queryByTestId("summary")).toBeNull()
    expect(screen.queryByTestId("hit-rate")).toBeNull()

    const useCase = idOf("use_case")
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: useCase, artifact_id: "o0", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_finished", node_id: useCase, artifact_id: "o1", cache_hit: false, duration_ms: 1 })
    es.emit(5, { event: "stream_end", status: "finished", ok: true })

    const summary = await screen.findByTestId("summary")
    expect(summary.className).not.toContain("font-mono")
    expect(summary.querySelector("span.font-mono")).not.toBeNull()
    expect(screen.getByTestId("hit-rate")).toBeTruthy()
    expect(document.body.textContent).not.toContain("Scoring question")
    expect(document.body.textContent).toContain("Found at rank 7, below the top 5.")
    // Verdict words and the meta line in sans; only numbers and the id in mono.
    for (const row of document.querySelectorAll<HTMLElement>("details[data-question] summary")) {
      const [verdict, , words] = [...row.children] as HTMLElement[]
      expect(verdict.className).toContain("font-sans")
      const meta = words.lastElementChild as HTMLElement
      expect(meta.className).not.toContain("font-mono")
      expect(meta.querySelector(".font-mono")).not.toBeNull()
    }
  })

  it("keeps saying the k that was scored when the Top k input changes after the run", async () => {
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
    await waitFor(() => expect(document.body.textContent).toContain("Found at rank 7, below the top 5."))
    await screen.findByTestId("pieces-warning")

    fireEvent.change(screen.getByLabelText("Top k"), { target: { value: "10" } })
    expect((screen.getByLabelText("Top k") as HTMLInputElement).value).toBe("10")

    expect(document.body.textContent).toContain("Found at rank 7, below the top 5.")
    expect(document.body.textContent).not.toContain("below the top 10")
    expect(screen.getByTestId("hit-rate").textContent).toMatch(/^Hit rate at 5 /)
    expect(screen.getByTestId("pieces-warning").textContent).toBe(
      "This pipeline makes only 7 pieces and the top 5 are checked, so most questions find the answer by chance. Use smaller pieces or a lower Top k.",
    )
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
