import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import type { PipelineConfig } from "@/state/config"
import { resetDocumentForTests } from "@/state/document"
import { storePreviousEvaluation } from "@/state/evaluate"
import { LIST_KEY, resetPipelinesForTests, setCurrentId, STARTER_ID } from "@/state/pipelines"
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
const question = (id: string, document: string | undefined) => ({ id, question: `Question ${id}?`, gold_answers: ["g"], answer: "", tags: [], ...(document ? { document } : {}) })
const some = (n: number, sha: string) => Array.from({ length: n }, (_, i) => question(`${sha.slice(0, 2)}${i}`, sha))

const SERVE_PREVIEW = {
  filename: "my-pipeline.zip",
  files: {
    "README.md": "# Serve readme",
    "pipeline.yaml": "index:\n  store: qdrant\n",
    "serve.py": "app = 1",
    "evals/questions.json": JSON.stringify({ questions: [{ id: "1" }, { id: "2" }] }),
  },
  keys: [
    { variable: "ANTHROPIC_API_KEY", optional: false, note: "Lets the answer model reply." },
    { variable: "DATABASE_URL", optional: true, note: "Where conversations are kept." },
  ],
  left_out: { categories: [{ id: "notes", reason: "no questions" }], documents: true, lock: true },
}
const LAPTOP_PREVIEW = { filename: "my-pipeline.zip", files: { "README.md": "# Laptop readme", "run.py": "print(1)" }, limited: [], keys: [], max_questions: null }

let demo = false
let own: unknown[] = []
let oneDoc: unknown = null
let samples: unknown[] = []
let serveStatus = 200
let samplesFail = false
let posts: { url: string; body: Record<string, unknown> }[] = []

function seed(documents = [{ sha: A, filename: "report.pdf", category: "reports" }, { sha: B, filename: "notes.pdf", category: "notes" }]) {
  storeWorking({ config, documents, question: { text: "", gold_answers: [] } })
}

const SAMPLE_CARD = { name: "primer", title: "P", blurb: "", shows: "", stresses: "chunk", pages: 1, default: true, filename: "report.pdf", sha: A, question: "?" }
const sampleQuestions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, question: `S${i}?`, gold_answer: "g" }))

const navigate = vi.fn()

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetWorkingForTests()
  resetPipelinesForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
  demo = false
  serveStatus = 200
  samplesFail = false
  own = [...some(10, A), ...some(4, B)]
  oneDoc = null
  samples = []
  posts = []
  navigate.mockClear()
  URL.createObjectURL = vi.fn(() => "blob:x")
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) })
      if (url === "/api/settings/app") return ok(demo ? { demo: true, limits: { max_bytes: 1, max_pages: 1, max_files: 1, max_total_bytes: 1, ttl_hours: 24, max_evaluation_questions: 50 } } : { demo: false })
      if (url === "/api/samples") return samplesFail ? new Response("{}", { status: 500 }) : ok(samples)
      if (url === "/api/samples/primer/questions") return ok(sampleQuestions(12))
      if (url.startsWith("/api/v2/questions?")) return ok({ documents: [A, B], count: own.length, questions: own })
      if (url.startsWith("/api/v2/documents/") && url.endsWith("/questions")) return oneDoc ? ok(oneDoc) : ok(null)
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
  // The files are asked for once the questions are read, so the page is settled when they or an error show.
  await waitFor(() => expect(screen.queryByTestId("take-home-columns") ?? screen.queryByRole("alert")).toBeTruthy())
}
const lastBody = (url: string) => posts.filter((p) => p.url === url).at(-1)?.body

describe("Take it home: step 1, check your questions", () => {
  it("has a heading per step, in the prototype's order, and a way back to Build", async () => {
    seed()
    await shown()
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["1 Check your questions", "2 Where it will run", "3 Download"])
    expect(screen.getByRole("link", { name: "Back to Build" }).getAttribute("href")).toBe("/build")
  })

  it("the lead names the pipeline", async () => {
    seed()
    window.localStorage.setItem(
      LIST_KEY,
      JSON.stringify([{ id: "p1", name: "acme-handbook", savedAt: new Date().toISOString(), config: { index: { parse: step, chunk: step, store: step } }, documents: [], question: { text: "", gold_answers: [] } }]),
    )
    resetPipelinesForTests()
    setCurrentId("p1")
    await shown()
    expect(screen.getByText(/Download your pipeline/).textContent).toContain("acme-handbook")
  })

  it("says in a sentence how many categories are ready and how many questions go in", async () => {
    seed()
    await shown()
    expect(screen.getByText(/1 of 3 categories are ready/)).toBeTruthy()
    expect(screen.getByText(/questions go into the download/).textContent).toContain("14")
  })

  it("each row has a status word with a mark, a sentence, a count and tagged documents", async () => {
    seed()
    await shown()
    const reports = screen.getByTestId("row-reports")
    expect(within(reports).getByText(/✓ Ready\./)).toBeTruthy()
    expect(within(reports).getByText("10")).toBeTruthy()
    expect(within(reports).getByText("report.pdf")).toBeTruthy()
    expect(within(reports).getByText("Your upload")).toBeTruthy()
    const notes = screen.getByTestId("row-notes")
    expect(within(notes).getByText(/! Weak check\./)).toBeTruthy()
    expect(notes.textContent).toContain("Only 4 questions. With so few, one bad change can slip through. Aim for 10 or more.")
    const tables = screen.getByTestId("row-tables")
    expect(within(tables).getByText(/- Not tested\./)).toBeTruthy()
    expect(within(tables).getByText("No document tested yet")).toBeTruthy()
    expect(within(tables).getByText("Empty")).toBeTruthy()
  })

  it("a weak check offers to write the questions it lacks and opens Evaluate on that document", async () => {
    seed()
    await shown()
    fireEvent.click(within(screen.getByTestId("row-notes")).getByRole("button", { name: "Write 6 more questions" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/evaluate"))
    expect(readWorking()?.documents.map((d) => d.filename)).toEqual(["notes.pdf"])
  })

  it("not tested names the action after the category and goes to Build", async () => {
    seed()
    await shown()
    expect(within(screen.getByTestId("row-tables")).getByRole("link", { name: "Test a table on Build" }).getAttribute("href")).toBe("/build")
  })

  it("a sample document's questions stay sample-only, tagged Sample, with an Add action", async () => {
    samples = [SAMPLE_CARD]
    seed()
    own = []
    await shown()
    const row = screen.getByTestId("row-reports")
    await waitFor(() => expect(within(row).getByText(/Sample questions only\./)).toBeTruthy())
    expect(within(row).getByText("Sample")).toBeTruthy()
    expect(within(row).getByRole("link", { name: "Add a report document" }).getAttribute("href")).toBe("/build")
    expect(row.textContent).toContain("These 12 questions are about our sample")
  })

  it("the sample's questions still load when another document has a kept set", async () => {
    samples = [SAMPLE_CARD]
    seed()
    own = some(10, B)
    await shown()
    await waitFor(() => expect(within(screen.getByTestId("row-reports")).getByText(/Sample questions only\./)).toBeTruthy())
    expect(within(screen.getByTestId("row-notes")).getByText(/✓ Ready\./)).toBeTruthy()
  })

  it("one document: its own stored set counts even though its questions name no document", async () => {
    seed([{ sha: A, filename: "report.pdf", category: "reports" }])
    const bare = some(10, A).map(({ document: _d, ...q }) => q)
    oneDoc = { sha: A, filename: "q.json", format: "json", count: 10, set: { version: 1, document: "report.pdf", questions: bare } }
    await shown()
    await waitFor(() => expect(within(screen.getByTestId("row-reports")).getByText(/✓ Ready\./)).toBeTruthy())
    await waitFor(() => expect(lastBody("/api/v2/projects/serve?preview=1")?.categories).toBeTruthy())
    const sent = (lastBody("/api/v2/projects/serve?preview=1")?.categories as Record<string, { questions: { document: string }[] }>).reports
    expect(sent.questions).toHaveLength(10)
    expect(sent.questions[0].document).toBe("report.pdf")
  })

  it("one document on the demo: the set Evaluate keeps in this tab counts", async () => {
    demo = true
    seed([{ sha: A, filename: "report.pdf", category: "reports" }])
    window.sessionStorage.setItem(
      "rag-playground:gold-set",
      JSON.stringify({ sha: A, filename: "q.json", format: "json", count: 10, set: { version: 1, document: "report.pdf", questions: some(10, A) } }),
    )
    await shown()
    await waitFor(() => expect(within(screen.getByTestId("row-reports")).getByText(/✓ Ready\./)).toBeTruthy())
  })

  it("a pipeline with no documents is not stuck loading", async () => {
    seed([])
    await shown()
    expect(within(screen.getByTestId("row-reports")).getByText(/Not tested\./)).toBeTruthy()
    await screen.findByTestId("take-home-columns")
  })

  it("shows the whole pipeline's last Evaluate score once, as a reference", async () => {
    seed()
    storePreviousEvaluation({
      sourceSha: `${A},${B}`,
      pipelineKey: "working",
      byId: {},
      totals: { total: 14, scored: 14, found: 13, hit_rate: 0.9, mrr: null, recall: null, mean_rank: null, median_rank: null } as never,
    })
    await shown()
    expect(screen.getAllByText(/found 13 of 14/)).toHaveLength(1)
    expect(screen.getByText(/shown only for reference/)).toBeTruthy()
    expect(screen.getByText(/recorded later, on your server/)).toBeTruthy()
    expect(within(screen.getByTestId("row-reports")).queryByText(/found/)).toBeNull()
  })

  it("when the sample list cannot be read the page still loads", async () => {
    samplesFail = true
    seed()
    await shown()
    await screen.findByTestId("take-home-columns")
    expect(within(screen.getByTestId("row-reports")).getByText(/✓ Ready\./)).toBeTruthy()
  })

  it("on the unedited Starter, shows the score saved under the Starter", async () => {
    seed()
    setCurrentId(STARTER_ID)
    storePreviousEvaluation({
      sourceSha: `${A},${B}`,
      pipelineKey: STARTER_ID,
      byId: {},
      totals: { total: 9, scored: 9, found: 7, hit_rate: 0.8, mrr: null, recall: null, mean_rank: null, median_rank: null } as never,
    })
    await shown()
    expect(screen.getAllByText(/found 7 of 9/)).toHaveLength(1)
  })

  it("questions that name no document are counted apart", async () => {
    seed()
    own = [...some(10, A), question("free", undefined)]
    await shown()
    expect(screen.getByTestId("row-unnamed").textContent).toContain("1 question names no document, so it has no category.")
  })
})

describe("Take it home: step 2, where it will run", () => {
  it("holds the documents, the index and the secrets", async () => {
    seed()
    await shown()
    expect(screen.getByLabelText("Where your documents live")).toBeTruthy()
    expect(screen.getByText(/gs:\/\//)).toBeTruthy()
    expect(screen.getByText("Where the index lives")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Secrets you set on your server" })).toBeTruthy()
    expect(await screen.findByText("ANTHROPIC_API_KEY")).toBeTruthy()
    expect(screen.getByText(/Lets the answer model reply/)).toBeTruthy()
    expect(screen.getByText(/Who can read what:/)).toBeTruthy()
  })

  it("secrets are listed by variable name and no field asks for a key", async () => {
    seed()
    await shown()
    await screen.findByText("ANTHROPIC_API_KEY")
    expect(screen.queryByLabelText(/key/i)).toBeNull()
    expect(screen.getByText(/never asks for them/)).toBeTruthy()
  })

  it("offers an address only for Qdrant, never a remote LanceDB", async () => {
    seed()
    await shown()
    expect(screen.queryByLabelText("Its address")).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: "Qdrant" }))
    fireEvent.change(await screen.findByLabelText("Its address"), { target: { value: "http://q:6333" } })
    await waitFor(() => expect(lastBody("/api/v2/projects/serve?preview=1")?.where).toEqual({ source: "./docs", index_store: "qdrant", index_url: "http://q:6333" }))
    fireEvent.click(screen.getByRole("radio", { name: "LanceDB" }))
    expect(screen.queryByLabelText("Its address")).toBeNull()
  })

  it("choosing the laptop project says these settings are not used and sends the questions", async () => {
    seed()
    await shown()
    fireEvent.click(screen.getByRole("radio", { name: /Try it on my laptop/ }))
    expect(screen.getByText(/so these settings are not used/)).toBeTruthy()
    expect(screen.queryByText("Secrets you set on your server")).toBeNull()
    await waitFor(() => expect(screen.getByRole("button", { name: /run\.py/ })).toBeTruthy())
    const sent = lastBody("/api/project.zip?preview=1")?.questions as { questions: { document: string }[] }
    expect(sent.questions).toHaveLength(14)
    expect(sent.questions[0].document).toBe("report.pdf")
  })
})

describe("Take it home: step 3, download", () => {
  it("lists the files with a line each and opens on pipeline.yaml", async () => {
    seed()
    await shown()
    await screen.findByTestId("take-home-columns")
    expect(screen.getByRole("heading", { name: /In the download/ }).textContent).toContain("4 files")
    expect(screen.getByTestId("take-home-preview").textContent).toContain("store: qdrant")
    expect(screen.getByRole("button", { name: /serve\.py/ }).textContent).toContain("Starts the chat API.")
    expect(screen.getByRole("button", { name: /evals\/questions\.json/ }).textContent).toContain("2 questions, tagged by category.")
    fireEvent.click(screen.getByRole("button", { name: /README\.md/ }))
    expect(screen.getByTestId("take-home-preview").textContent).toContain("Serve readme")
  })

  it("the left out list is for the team project: categories, documents and uv.lock", async () => {
    seed()
    await shown()
    const out = await screen.findByTestId("take-home-left-out")
    expect(out.textContent).toContain("Notes")
    expect(out.textContent).toContain("No questions yet.")
    expect(out.textContent).toContain("Tables")
    expect(out.textContent).toContain("docs/")
    expect(out.textContent).toContain("uv.lock")
    fireEvent.click(screen.getByRole("radio", { name: /Try it on my laptop/ }))
    await waitFor(() => expect(screen.queryByTestId("take-home-left-out")).toBeNull())
  })

  it("download posts the export and saves the zip", async () => {
    seed()
    await shown()
    const button = await screen.findByRole("button", { name: /Download my-pipeline\.zip/ })
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(posts.map((p) => p.url)).toContain("/api/v2/projects/serve"))
    await screen.findByText(/Downloaded/)
    expect(Object.keys(lastBody("/api/v2/projects/serve")?.categories as object)).toEqual(["reports", "notes"])
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(screen.getByText(/record your starting score/)).toBeTruthy()
  })

  it("sends a plain pipeline as it is, its questions under default", async () => {
    const plain = { index: { parse: step, chunk: step, store: step } } as unknown as PipelineConfig
    storeWorking({ config: plain, documents: [{ sha: A, filename: "report.pdf" }], question: { text: "", gold_answers: [] } })
    oneDoc = { sha: A, filename: "q.json", format: "json", count: 10, set: { version: 1, document: "report.pdf", questions: some(10, A) } }
    render(<TakeHomePage navigate={navigate} />)
    await waitFor(() => expect(lastBody("/api/v2/projects/serve?preview=1")).toBeTruthy())
    const sent = lastBody("/api/v2/projects/serve?preview=1")
    expect(sent?.config).toEqual(plain)
    expect(Object.keys(sent?.categories as object)).toEqual(["default"])
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
})

describe("Take it home: the hosted demo", () => {
  it("opens with a banner that says what lives only in the tab and how many questions are used", async () => {
    demo = true
    seed()
    await shown()
    expect(await screen.findByText("You are on the hosted demo.")).toBeTruthy()
    expect(screen.getByText(/live only in this browser tab/)).toBeTruthy()
    expect(screen.getByText(/The demo keeps up to 50 questions\./).textContent).toContain("used 14 of 50")
  })

  it("has no banner locally", async () => {
    seed()
    await shown()
    expect(screen.queryByText("You are on the hosted demo.")).toBeNull()
  })
})

describe("Take it home: plain words", () => {
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
