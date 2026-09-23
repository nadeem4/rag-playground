import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { GoldQuestion, QuestionSetUpload, Registry, SampleQuestion } from "@/api/types"
import { sampleGraph, storeGraph } from "@/state/graph"

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
 * `sampleSha` is what `POST /api/sources/sample` answers, which is how the page
 * knows whether the built-in question set describes the loaded document.
 * `stored` is what `GET /api/sources/{sha}/questions` has, null for no set.
 */
function serve({
  reg = liveRegistry,
  sampleSha = SOURCE.sha,
  stored = null,
  upload,
  demo = false,
}: {
  reg?: unknown
  sampleSha?: string | null
  stored?: QuestionSetUpload | null
  upload?: QuestionSetUpload | { status: number }
  demo?: boolean
} = {}) {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/registry") return ok(reg)
      if (url === "/api/settings/app") return ok({ demo })
      if (url === "/api/samples/questions") return ok(QUESTIONS)
      if (url === "/api/sources/sample") return sampleSha ? ok({ sha: sampleSha, filename: "chunking-primer.pdf", size: 1, content_type: "application/pdf" }) : missing()
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
}

/** A file dropped into the hidden input, which jsdom will not build for us. */
function chooseFile(input: HTMLElement, name: string) {
  const file = new File(["id,question\n"], name, { type: "text/csv" })
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
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
})

describe("the question set panel", () => {
  beforeEach(() => storeGraph(sampleGraph(registry, SOURCE)))

  it("names the built-in sample set, counts it, and links to a template in both formats", async () => {
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("the built-in sample question set"))
    await waitFor(() => expect(screen.getByTestId("question-set").textContent).toMatch(/2 questions/))
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

  it("warns, and offers the upload, when the sample questions were not written for the loaded document", async () => {
    serve({ sampleSha: OTHER_SHA })
    render(<Evaluate />)
    const warning = await screen.findByTestId("set-mismatch", {}, { timeout: 4000 })
    expect(warning.textContent).toMatch(/not for chunking-primer.pdf/)
    expect(warning.textContent).toMatch(/measures nothing/)
    expect(warning.querySelector("button")!.textContent).toBe("Upload a question set")
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
    await waitFor(() => expect(screen.getByTestId("set-name").textContent).toBe("the built-in sample question set"))
  })

  it("says an uploaded set lives in this browser tab when the server would not keep it", async () => {
    serve({ upload: goldSet({ stored: false }) })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
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
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")

    const report = await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    expect(report.textContent).toMatch(/Read 2 questions from refunds.csv/)
    expect(report.textContent).toMatch(/1 of 2 gold passages was not found/)
    expect(report.textContent).toMatch(/The duty manager approves it\./)
    expect(report.textContent).toMatch(/The duty manager signs it off\./)
    expect(report.textContent).toMatch(/as the pdfium parser reads it/)
    // A set with problems is still in use: the page swapped to it.
    expect(screen.getByTestId("set-name").textContent).toBe("refunds.csv")
  })

  it("stays on screen after the set is in use, and has no em-dashes or en-dashes", async () => {
    serve({ upload: goldSet() })
    render(<Evaluate />)
    await waitFor(() => expect(screen.getByTestId("set-name")).toBeTruthy())
    chooseFile(screen.getByLabelText("Upload a question set"), "refunds.csv")
    await screen.findByTestId("upload-report", {}, { timeout: 4000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/2 questions ready/))
    expect(screen.getByTestId("upload-report")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})
