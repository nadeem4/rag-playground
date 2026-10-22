import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import registryFixture from "@/api/fixtures/registry.json"
import { resetSampleQuestionsCache } from "@/api/samples"
import type { Registry } from "@/api/types"
import { graphToConfig } from "@/state/config"
import { questionsKey, storePreviousEvaluation, type PreviousEvaluation } from "@/state/evaluate"
import { sampleGraph } from "@/state/graph"

import { TakeHome } from "./TakeHome"

const registry = registryFixture as unknown as Registry
const SHA = "ab".repeat(32)
const graph = sampleGraph(registry, { sha: SHA, filename: "report.pdf" }, "What is it?")

const STORED = {
  sha: SHA,
  filename: "report-questions.json",
  format: "json",
  count: 3,
  set: {
    version: 1,
    document: "report.pdf",
    questions: ["q1", "q2", "q3"].map((id) => ({ id, question: `${id}?`, gold_answers: ["x"], tags: [], answer: "", document: "report.pdf" })),
  },
}

interface Body {
  config: unknown
  name: string
  questions?: unknown
  scores?: string
}

let keys: { variable: string; optional: boolean }[]
let limited: { setting: string; value: number; cap: number }[]
let storedSet: unknown
let zipStatus: number
let calls: { url: string; body: Body }[]
let samples: unknown[]
let maxQuestions: number | null
let serverCap: number | null
let previewDelay: number

/** The server's preview: questions.json only when questions were sent, the scores in the README only when sent. */
function preview(body: Body) {
  const files: Record<string, string> = {
    "pipeline.yaml": "path: ./pandion-index\nindex:\n  parse:\n    use: pdfium\n",
    "run.py": '"""Index the files in docs/ with pipeline.yaml."""\n',
    "requirements.txt": "pandion[local]~=0.2.0\n",
    "README.md": `# my-pipeline\n\nFrom the server.${body.scores ? `\n\n## Scores to beat\n\n${body.scores}` : ""}\n`,
    "docs/.gitkeep": "",
  }
  if (body.questions) files["questions.json"] = "{}"
  return { filename: "my-pipeline.zip", files, limited, keys, max_questions: maxQuestions }
}

beforeEach(() => {
  window.sessionStorage.clear()
  resetSampleQuestionsCache()
  keys = [{ variable: "ANTHROPIC_API_KEY", optional: false }]
  limited = []
  storedSet = STORED
  zipStatus = 200
  calls = []
  samples = []
  maxQuestions = null
  serverCap = null
  previewDelay = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith("/api/project.zip")) {
        const body = JSON.parse(String(init?.body)) as Body
        calls.push({ url: u, body })
        const sent = (body.questions as { questions?: unknown[] } | undefined)?.questions?.length ?? 0
        if (serverCap !== null && sent > serverCap)
          return new Response(JSON.stringify({ detail: `The demo packs at most ${serverCap} questions into a project, and this set has ${sent}.` }), { status: 413 })
        if (u.endsWith("?preview=1")) {
          if (previewDelay) await new Promise((r) => setTimeout(r, previewDelay))
          return new Response(JSON.stringify(preview(body)))
        }
        if (zipStatus !== 200) return new Response(JSON.stringify({ detail: "The pipeline loads plugins (x)." }), { status: zipStatus })
        return new Response("PK", { headers: { "content-type": "application/zip" } })
      }
      if (u.endsWith(`/documents/${SHA}/questions`)) return new Response(JSON.stringify(storedSet))
      if (u.endsWith("/api/samples")) return new Response(JSON.stringify(samples))
      if (u.endsWith("/api/samples/primer/questions"))
        return new Response(JSON.stringify([{ id: "s1", question: "One?", gold_answer: "one" }, { id: "s2", question: "Two?", gold_answer: "two" }]))
      return new Response("null", { status: 404 })
    }),
  )
  URL.createObjectURL = vi.fn(() => "blob:zip")
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CONFIG = (graphToConfig(graph) as unknown as { ok: true; pipeline: { config: Record<string, unknown> } }).pipeline.config

/** An Evaluate result for this pipeline and set, at Pandion's default top k, unless `change` says otherwise. */
function scored(change: Partial<PreviousEvaluation> = {}) {
  storePreviousEvaluation({
    sourceSha: SHA,
    pipelineKey: "working",
    byId: {},
    totals: { total: 3, scored: 3, found: 2, hit_rate: 0.67, mrr: 0.5, recall: null, mean_rank: null, median_rank: null },
    config: CONFIG,
    questions: questionsKey(STORED.set.questions),
    k: 5,
    ...change,
  })
}

async function open() {
  render(<TakeHome graph={graph} name="My pipeline" pipelineKey={null} registry={registryFixture as unknown as Registry} />)
  fireEvent.click(screen.getByRole("button", { name: "Take it home" }))
  const sheet = await screen.findByRole("dialog", { name: "Take this pipeline home" })
  await within(sheet).findByRole("button", { name: /README\.md/ })
  return sheet
}

const fileNames = (sheet: HTMLElement) =>
  within(within(sheet).getByRole("region", { name: "In the zip" }))
    .getAllByRole("button")
    .map((b) => b.querySelector(".font-mono")?.textContent)

describe("TakeHome", () => {
  it("opens the sheet with the server's file list and the README preview", async () => {
    const sheet = await open()

    await waitFor(() => expect(fileNames(sheet)).toEqual(["README.md", "pipeline.yaml", "run.py", "questions.json", "requirements.txt", "docs/"]))
    expect(within(sheet).getByTestId("take-home-preview").textContent).toContain("From the server.")
    expect(calls[0].url).toBe("/api/project.zip?preview=1")
    expect(calls[0].body.config).toEqual((graphToConfig(graph) as { ok: true; pipeline: { config: unknown } }).pipeline.config)
    expect(calls[0].body.name).toBe("My pipeline")
  })

  it("shows a file's server text when it is clicked", async () => {
    const sheet = await open()

    fireEvent.click(within(sheet).getByRole("button", { name: /pipeline\.yaml/ }))

    expect(within(sheet).getByRole("button", { name: /pipeline\.yaml/ }).getAttribute("aria-pressed")).toBe("true")
    expect(within(sheet).getByTestId("take-home-preview").textContent).toContain("path: ./pandion-index")
  })

  it("names the documents, the key and the index under Not in the zip", async () => {
    const sheet = await open()
    const out = within(sheet).getByRole("region", { name: "Not in the zip" })

    expect(within(out).getByText("report.pdf")).toBeTruthy()
    expect(within(out).getByText("Anthropic key")).toBeTruthy()
    expect(out.textContent).toContain("Keys are never written to a file, so the zip only names the variable to set.")
    expect(out.textContent).toContain("ANTHROPIC_API_KEY")
    expect(out.textContent).not.toContain("never leave")
    expect(within(out).getByText("Saved index")).toBeTruthy()
  })

  it("says no key is needed when the pipeline reads none", async () => {
    keys = []
    const sheet = await open()
    const out = within(sheet).getByRole("region", { name: "Not in the zip" })

    expect(out.textContent).toContain("This pipeline needs no key.")
    expect(out.textContent).not.toContain("_API_KEY")
    expect(within(out).queryByText("API key")).toBeNull()
  })

  it("offers the questions and the scores, and unticking either changes the files", async () => {
    scored()
    const sheet = await open()

    const questions = await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    const scores = within(sheet).getByRole("checkbox", { name: /Scores to beat/ })
    expect(sheet.textContent).toContain("2 of 3 found, MRR 0.50")
    await waitFor(() => expect(within(sheet).getByTestId("take-home-preview").textContent).toContain("## Scores to beat"))
    expect(calls.at(-1)!.body.scores).toBe("2 of 3 found, MRR 0.50")
    expect(calls.at(-1)!.body.questions).toEqual(STORED.set)

    fireEvent.click(scores)
    await waitFor(() => expect(within(sheet).getByTestId("take-home-preview").textContent).not.toContain("Scores to beat"))
    expect(calls.at(-1)!.body.scores).toBe("")

    fireEvent.click(questions)
    await waitFor(() => expect(fileNames(sheet)).not.toContain("questions.json"))
    expect(calls.at(-1)!.body.questions).toBeUndefined()
  })

  it("shows neither box without a question set or a result for this pipeline", async () => {
    storedSet = null
    const sheet = await open()

    expect(within(sheet).queryByRole("checkbox")).toBeNull()
    expect(within(sheet).queryByText("Include")).toBeNull()
  })

  it("offers a sample's own questions when no set was uploaded", async () => {
    storedSet = null
    samples = [{ name: "primer", title: "A primer", sha: SHA, filename: "report.pdf", default: true }]
    const sheet = await open()

    await within(sheet).findByRole("checkbox", { name: /Your 2 questions/ })
    expect(sheet.textContent).toContain("From the sample's own question set.")
    await waitFor(() => expect(calls.at(-1)!.body.questions).toBeTruthy())
    const sent = calls.at(-1)!.body.questions as { document: string; questions: { id: string; gold_answers: string[]; document: string }[] }
    expect(sent.document).toBe("report.pdf")
    expect(sent.questions.map((q) => [q.id, q.gold_answers, q.document])).toEqual([
      ["s1", ["one"], "report.pdf"],
      ["s2", ["two"], "report.pdf"],
    ])
  })

  it.each([
    ["another top k", { k: 10 }],
    ["no top k", { k: undefined }],
    ["another pipeline", { config: { ...CONFIG, retrieve: { ...(CONFIG.retrieve as object), rewrite: { use: "llm_rewrite" } } } }],
    ["an older entry with no pipeline", { config: undefined }],
    ["another question text", { questions: questionsKey(STORED.set.questions.map((q, i) => (i ? q : { ...q, question: "Changed?" }))) }],
    ["another gold passage", { questions: questionsKey(STORED.set.questions.map((q, i) => (i ? q : { ...q, gold_answers: ["y"] }))) }],
  ] as [string, Partial<PreviousEvaluation>][])("shows no scores for a result with %s", async (_, change) => {
    scored(change)
    const sheet = await open()

    await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    expect(within(sheet).queryByRole("checkbox", { name: /Scores to beat/ })).toBeNull()
  })

  it("over the demo's question cap, offers the questions unticked and disabled, and packs none", async () => {
    maxQuestions = 2
    const sheet = await open()

    const box = await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    expect((box as HTMLInputElement).checked).toBe(false)
    expect((box as HTMLInputElement).disabled).toBe(true)
    expect(sheet.textContent).toContain("The demo packs at most 2 questions.")
    expect(calls.every((c) => c.body.questions === undefined)).toBe(true)
    expect(within(sheet).getByRole("button", { name: "Download my-pipeline.zip" }).hasAttribute("disabled")).toBe(false)
  })

  it("keeps the cap from a preview that answers after the question set arrived", async () => {
    maxQuestions = 2
    serverCap = 2
    previewDelay = 50
    const sheet = await open()

    const box = await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(true))
    expect((box as HTMLInputElement).checked).toBe(false)
    expect(sheet.textContent).toContain("The demo packs at most 2 questions.")
    expect(within(sheet).queryByRole("alert")).toBeNull()
    await waitFor(() => expect(calls.at(-1)!.body.questions).toBeUndefined())
    expect(within(sheet).getByRole("button", { name: "Download my-pipeline.zip" }).hasAttribute("disabled")).toBe(false)
  })

  it("takes a 413 for the questions as over the cap, and previews again without them", async () => {
    serverCap = 2 // the preview never says its cap: only the 413 does
    const sheet = await open()

    const box = await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(true))
    expect((box as HTMLInputElement).checked).toBe(false)
    expect(sheet.textContent).toContain("The demo packs at most 2 questions.")
    expect(within(sheet).queryByRole("alert")).toBeNull()
    await waitFor(() => expect(calls.at(-1)!.body.questions).toBeUndefined())
    expect(within(sheet).getByRole("button", { name: "Download my-pipeline.zip" }).hasAttribute("disabled")).toBe(false)
  })

  it("shows the server's demo-limited note", async () => {
    limited = [{ setting: "retrieve.rerank.1.text_budget_chars", value: 2400, cap: 2400 }]
    const sheet = await open()

    expect(sheet.textContent).toContain("Settings at the demo's cap.")
    expect(sheet.textContent).toContain("retrieve.rerank.1.text_budget_chars")
  })

  it("downloads the zip with the same body and says what to do next", async () => {
    scored()
    const sheet = await open()
    await within(sheet).findByRole("checkbox", { name: /Your 3 questions/ })
    await waitFor(() => expect(calls.at(-1)!.body.scores).toBe("2 of 3 found, MRR 0.50"))

    fireEvent.click(within(sheet).getByRole("button", { name: "Download my-pipeline.zip" }))

    expect(await within(sheet).findByText(/Unzip it, then follow the README\./)).toBeTruthy()
    const download = calls.at(-1)!
    expect(download.url).toBe("/api/project.zip")
    expect(download.body).toEqual({ ...calls.at(-2)!.body })
    expect(download.body.questions).toEqual(STORED.set)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it("shows the server's sentence when the download is refused", async () => {
    zipStatus = 400
    const sheet = await open()

    fireEvent.click(within(sheet).getByRole("button", { name: "Download my-pipeline.zip" }))

    expect(await within(sheet).findByText("The pipeline loads plugins (x).")).toBeTruthy()
    expect(within(sheet).queryByText(/Unzip it/)).toBeNull()
  })

  it("Cancel closes the sheet", async () => {
    const sheet = await open()

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }))

    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
