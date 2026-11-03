import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import type { PipelineConfig } from "@/state/config"
import { resetDocumentForTests } from "@/state/document"
import { storePreviousEvaluation } from "@/state/evaluate"
import { resetPipelinesForTests } from "@/state/pipelines"
import { readWorking, resetWorkingForTests, storeWorking } from "@/state/working"

import { TakeHomePage } from "./TakeHome"

const A = "aa".repeat(32)
const B = "bb".repeat(32)
const step = { use: "x" }
const def = (name: string) => ({ name, parse: step, chunk: step })
const config = {
  index: { store: step },
  categories: { reports: def("Reports"), notes: def("Notes"), tables: def("Tables") },
} as unknown as PipelineConfig

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const question = (id: string, document: string) => ({ id, question: `Question ${id}?`, gold_answers: ["g"], answer: "", tags: [], document })
const some = (n: number, sha: string) => Array.from({ length: n }, (_, i) => question(`${sha.slice(0, 2)}${i}`, sha))

const SERVE_PREVIEW = {
  filename: "my-pipeline.zip",
  files: { "README.md": "# Serve readme", "pipeline.yaml": "index:\n  store: qdrant\n", "evals/questions.json": "[]" },
  keys: [{ variable: "ANTHROPIC_API_KEY", optional: false, note: "Your key for Claude." }],
  left_out: { categories: [{ id: "notes", reason: "no questions" }], documents: true, lock: true },
}
const LAPTOP_PREVIEW = { filename: "my-pipeline.zip", files: { "README.md": "# Laptop readme" }, limited: [], keys: [], max_questions: null }

let demo = false
let own: unknown[] = []
let serveStatus = 200
let posts: { url: string; body: Record<string, unknown> }[] = []

function seed(documents = [{ sha: A, filename: "report.pdf", category: "reports" }, { sha: B, filename: "notes.pdf", category: "notes" }]) {
  storeWorking({ config, documents, question: { text: "", gold_answers: [] } })
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetWorkingForTests()
  resetPipelinesForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
  demo = false
  serveStatus = 200
  own = [...some(10, A), ...some(4, B)]
  posts = []
  URL.createObjectURL = vi.fn(() => "blob:x")
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) })
      if (url === "/api/settings/app") return ok(demo ? { demo: true, limits: { max_bytes: 1, max_pages: 1, max_files: 1, max_total_bytes: 1, ttl_hours: 24, max_evaluation_questions: 50 } } : { demo: false })
      if (url === "/api/samples") return ok([])
      if (url.startsWith("/api/v2/questions?")) return ok({ documents: [A, B], count: own.length, questions: own })
      if (url === "/api/v2/projects/serve?preview=1") {
        return serveStatus === 200 ? ok(SERVE_PREVIEW) : new Response(JSON.stringify({ detail: "A remote LanceDB index is not supported. Use Qdrant." }), { status: serveStatus })
      }
      if (url === "/api/v2/projects/serve") return new Response("zip", { status: 200 })
      if (url === "/api/project.zip?preview=1") return ok(LAPTOP_PREVIEW)
      if (url === "/api/project.zip") return new Response("zip", { status: 200 })
      return new Response("{}", { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function shown() {
  render(<TakeHomePage navigate={navigate} />)
  await screen.findByText("Reports")
}
const navigate = vi.fn()

describe("Take it home", () => {
  it("has a heading per step and states in words", async () => {
    seed()
    await shown()
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(heads).toEqual(["1. Check your questions", "2. Where it will run", "3. Download"])
    const reports = screen.getByTestId("row-reports")
    expect(within(reports).getByText("Ready")).toBeTruthy()
    expect(within(screen.getByTestId("row-notes")).getByText("Weak check")).toBeTruthy()
    expect(within(screen.getByTestId("row-tables")).getByText("Not tested")).toBeTruthy()
  })

  it("ready category shows its question count and a muted reference score", async () => {
    seed()
    storePreviousEvaluation({
      sourceSha: A,
      pipelineKey: "working",
      byId: {},
      totals: { total: 10, scored: 10, found: 8, hit_rate: 0.8, mrr: null, recall: null, mean_rank: null, median_rank: null } as never,
    })
    await shown()
    const reports = screen.getByTestId("row-reports")
    expect(within(reports).getByText("10 questions")).toBeTruthy()
    expect(within(reports).getByText(/Last score: 8 of 10 found/)).toBeTruthy()
    expect(within(screen.getByTestId("row-notes")).queryByText(/Last score/)).toBeNull()
  })

  it("weak check offers to write questions and opens Evaluate on that document", async () => {
    seed()
    await shown()
    fireEvent.click(within(screen.getByTestId("row-notes")).getByRole("button", { name: /Write questions/ }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/evaluate"))
    expect(readWorking()?.documents.map((d) => d.filename)).toEqual(["notes.pdf"])
  })

  it("sample-only offers to add a document of your own", async () => {
    seed()
    own = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/settings/app") return ok({ demo: false })
        if (url === "/api/samples") return ok([{ name: "primer", title: "P", blurb: "", shows: "", stresses: "chunk", pages: 1, default: true, filename: "report.pdf", sha: A, question: "?" }])
        if (url.startsWith("/api/v2/questions?")) return ok({ documents: [A, B], count: 0, questions: [] })
        if (url === "/api/samples/primer/questions") return ok(Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, question: `S${i}?`, gold_answer: "g" })))
        return ok(SERVE_PREVIEW)
      }),
    )
    await shown()
    const row = await screen.findByTestId("row-reports")
    await waitFor(() => expect(within(row).getByText("Sample questions only")).toBeTruthy())
    expect(within(row).getByRole("link", { name: /Add a document of your own/ }).getAttribute("href")).toBe("/build")
  })

  it("not tested offers to test one on Build", async () => {
    seed()
    await shown()
    expect(within(screen.getByTestId("row-tables")).getByRole("link", { name: /Test one on Build/ }).getAttribute("href")).toBe("/build")
  })

  it("choosing laptop hides where-it-runs and says the settings are not used", async () => {
    seed()
    await shown()
    expect(screen.getByLabelText("Index store")).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: /Try it on my laptop/ }))
    expect(screen.queryByLabelText("Index store")).toBeNull()
    expect(screen.getByText(/settings are not used for the laptop project/)).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("take-home-preview").textContent).toContain("Laptop readme"))
  })

  it("choosing the team project previews pipeline.yaml that follows the where-it-runs choices", async () => {
    seed()
    await shown()
    fireEvent.change(screen.getByLabelText("Index store"), { target: { value: "qdrant" } })
    fireEvent.change(await screen.findByLabelText("Index URL"), { target: { value: "http://q:6333" } })
    await waitFor(() => {
      const last = posts.filter((p) => p.url === "/api/v2/projects/serve?preview=1").at(-1)
      expect(last?.body.where).toEqual({ source: "./docs", index_store: "qdrant", index_url: "http://q:6333" })
    })
    fireEvent.click(await screen.findByRole("button", { name: "pipeline.yaml" }))
    expect(screen.getByTestId("take-home-preview").textContent).toContain("store: qdrant")
  })

  it("offers a remote URL only for Qdrant", async () => {
    seed()
    await shown()
    expect(screen.queryByLabelText("Index URL")).toBeNull()
    fireEvent.change(screen.getByLabelText("Index store"), { target: { value: "qdrant" } })
    expect(screen.getByLabelText("Index URL")).toBeTruthy()
  })

  it("secrets are listed by variable name and no field asks for a key", async () => {
    seed()
    await shown()
    await screen.findByText("ANTHROPIC_API_KEY")
    expect(screen.queryByLabelText(/key/i)).toBeNull()
    expect(screen.getByText(/never asked for here/)).toBeTruthy()
  })

  it("the left out list names categories, documents and uv.lock", async () => {
    seed()
    await shown()
    const out = await screen.findByTestId("take-home-left-out")
    expect(out.textContent).toContain("Notes: no questions")
    expect(out.textContent).toContain("Your documents")
    expect(out.textContent).toContain("uv.lock")
  })

  it("download posts the export and saves the zip", async () => {
    seed()
    await shown()
    const button = await screen.findByRole("button", { name: /Download my-pipeline\.zip/ })
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(posts.map((p) => p.url)).toContain("/api/v2/projects/serve"))
    await screen.findByText(/Downloaded/)
    const sent = posts.find((p) => p.url === "/api/v2/projects/serve")
    expect(Object.keys(sent?.body.categories as object)).toEqual(["reports", "notes"])
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it("shows the demo note and the count used", async () => {
    demo = true
    seed()
    await shown()
    expect(await screen.findByText(/live only in this browser tab/)).toBeTruthy()
    expect(screen.getByText(/14 of 50 questions/)).toBeTruthy()
  })

  it("a refused export shows its sentence", async () => {
    serveStatus = 400
    seed()
    await shown()
    expect((await screen.findByRole("alert")).textContent).toContain("A remote LanceDB index is not supported. Use Qdrant.")
  })

  it("stacks at phone width", async () => {
    seed()
    await shown()
    await screen.findByTestId("take-home-columns")
    expect(screen.getByTestId("take-home-columns").className).toContain("flex-wrap")
  })

  it("has no em-dash or en-dash in its visible text", async () => {
    seed()
    await shown()
    await screen.findByTestId("take-home-columns")
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })

  it("says to build a pipeline first when there is none", () => {
    render(<TakeHomePage navigate={navigate} />)
    expect(screen.getByRole("link", { name: /Build a pipeline/ }).getAttribute("href")).toBe("/build")
  })
})
