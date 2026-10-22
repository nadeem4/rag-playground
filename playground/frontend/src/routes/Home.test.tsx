import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { AppSettings, Registry, SampleCard, Source } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { documentOf, resetDocumentForTests } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph, storedGraphJson } from "@/state/graph"
import { resetPipelinesForTests } from "@/state/pipelines"

import { Home } from "./Home"

const registry = liveRegistry as unknown as Registry

const FIRST: SampleCard = {
  name: "two-column-report",
  title: "Two-column report",
  blurb: "Two pages laid out in two columns.",
  shows: "Reading order.",
  stresses: "parse",
  pages: 2,
  default: true,
  filename: "two-column-report.pdf",
  sha: "cd".repeat(32),
  question: "How long did the survey run?",
}
const SECOND: SampleCard = {
  ...FIRST,
  name: "scanned-notes",
  title: "Scanned notes",
  filename: "scanned-notes.pdf",
  sha: "ef".repeat(32),
  default: false,
  question: "What was noted?",
}
const OWN: Source = { sha: "ab".repeat(32), filename: "mine.pdf", size: 2048, content_type: "application/pdf" }

let posted: string[] = []
let uploaded: string[] = []
let holdUpload = false
let releaseUpload: () => void = () => {}
let refuseUpload: string | null = null
let linked: string[] = []
let refuseLink: string | null = null

const DEMO = {
  demo: true,
  limits: {
    max_bytes: 10485760,
    max_pages: 20,
    max_files: 3,
    max_total_bytes: 31457280,
    ttl_hours: 24,
    max_other_bytes: 2097152,
    max_image_bytes: 5242880,
  },
} as AppSettings

function serve({ settings = { demo: false } as AppSettings, sources = [] as Source[] } = {}) {
  posted = []
  uploaded = []
  linked = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/v2/strategies") return ok({ stages: liveRegistry })
      if (url === "/api/samples") return ok([FIRST, SECOND])
      if (url === "/api/v2/documents" && init?.method === "POST") {
        const file = (init.body as FormData).get("file") as File
        uploaded.push(file.name)
        if (refuseUpload) return new Response(JSON.stringify({ detail: refuseUpload }), { status: 422 })
        const answer = () => ok({ ...OWN, filename: file.name })
        return holdUpload ? new Promise<Response>((resolve) => (releaseUpload = () => resolve(answer()))) : answer()
      }
      if (url === "/api/v2/documents/url" && init?.method === "POST") {
        const link = JSON.parse(String(init.body ?? "{}")).url as string
        linked.push(link)
        if (refuseLink) return new Response(JSON.stringify({ detail: refuseLink }), { status: 422 })
        const answer = () => ok({ ...OWN, filename: "example.com" })
        return holdUpload ? new Promise<Response>((resolve) => (releaseUpload = () => resolve(answer()))) : answer()
      }
      if (url === "/api/v2/documents") return ok(sources)
      if (url === "/api/settings/app") return ok(settings)
      if (url === "/api/sources/sample" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body ?? "{}")).name as string)
        return ok({ sha: FIRST.sha, filename: FIRST.filename, size: 1000, content_type: "application/pdf" })
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetPipelinesForTests()
  resetAppSettingsForTests()
  holdUpload = false
  refuseUpload = null
  refuseLink = null
  serve()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LESSONS_DOC = "https://github.com/nadeem4/rag-playground/blob/main/docs/lessons-learned.md"

const region = (name: string) => screen.getByRole("region", { name })

describe("Home's hero", () => {
  it("names the reader, the promise, the lede and what they leave with", () => {
    render(<Home navigate={vi.fn()} />)
    expect(screen.getByText("For developers building search over their own knowledge")).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1, name: "Tune a RAG pipeline on your own knowledge, then take it home." })).toBeTruthy()
    expect(screen.getByText(/^Bring your documents, web pages or photos of pages\./)).toBeTruthy()
    const outcome = screen.getByText("You leave with").parentElement!
    expect(outcome.textContent).toContain("a Python project that runs the winning pipeline on your computer")
    expect(within(outcome).getByText("Pandion")).toBeTruthy()
  })

  it("has the three actions with their targets, each 44 px tall", () => {
    render(<Home navigate={vi.fn()} />)
    const sample = screen.getByRole("button", { name: "Try a sample" })
    const own = screen.getByRole("button", { name: "Use your own files" })
    const home = screen.getByRole("link", { name: "See what you take home" })
    expect(home.getAttribute("href")).toBe("#pandion")
    expect(document.getElementById("pandion")).toBeTruthy()
    for (const el of [sample, own, home]) expect(el.className.split(/\s+/)).toContain("min-h-[44px]")
  })

  it("states the three facts, saying files stay private to the browser on the demo", async () => {
    serve({ settings: DEMO })
    render(<Home navigate={vi.fn()} />)
    expect(await screen.findByText("Your files stay private to your browser")).toBeTruthy()
    for (const fact of ["No sign in", "A key is needed only for model steps"]) expect(screen.getByText(fact)).toBeTruthy()
    expect(screen.queryByText("Your files stay on this machine.")).toBeNull()
  })

  it("says files stay on this machine as a fact when running locally, and only once", async () => {
    render(<Home navigate={vi.fn()} />)
    const fact = await screen.findByText("Your files stay on this machine.")
    expect(fact.closest("li")).toBeTruthy()
    expect(screen.queryByText("Your files stay private to your browser")).toBeNull()
  })

  it("Try a sample opens Build on the Starter pipeline with the default sample, whatever document is loaded", async () => {
    serve({ sources: [OWN] })
    storeGraph(sampleGraph(registry, OWN))
    const before = storedGraphJson()
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Try a sample" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/build?starter=${FIRST.name}`))
    expect(posted).toEqual([])
    expect(storedGraphJson()).toBe(before)
  })
})

describe("Home's finding slip", () => {
  it("shows the scanned notes finding: 0 of 8 with OCR off, 8 of 8 with OCR on, why, and its source", () => {
    render(<Home navigate={vi.fn()} />)
    const slip = screen.getByRole("figure", { name: "A real finding from the scanned notes sample" })
    expect(within(slip).getByText("Docling, OCR off")).toBeTruthy()
    expect(within(slip).getByText("0 of 8")).toBeTruthy()
    expect(within(slip).getByText("Docling, OCR on")).toBeTruthy()
    expect(within(slip).getByText("8 of 8")).toBeTruthy()
    expect(within(slip).getByText(/^A scan is pictures of pages, so there was no text to search\./)).toBeTruthy()
    expect(within(slip).getByRole("link", { name: "From the scanned notes sample. Lessons learned, Parsing." }).getAttribute("href")).toBe(
      `${LESSONS_DOC}#a-scanned-pdf-has-no-text-to-read`,
    )
  })
})

describe("Home's four steps", () => {
  const tabs = () => screen.getAllByRole("tab")
  const panel = () => screen.getByRole("tabpanel")
  const sources = () => [...panel().querySelectorAll("source")].map((s) => s.getAttribute("src"))

  it("are real tabs, Build first and selected, with its clip in light and dark", () => {
    render(<Home navigate={vi.fn()} />)
    expect(screen.getByRole("tablist", { name: "From your files to a project you own" })).toBeTruthy()
    expect(tabs().map((t) => t.querySelector("strong")!.textContent)).toEqual(["Build", "Evaluate", "Compare", "Take it home"])
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"])
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1])
    expect(panel().getAttribute("aria-labelledby")).toBe(tabs()[0].id)
    expect(sources()).toEqual(["/clips/build-dark.webm", "/clips/build.webm"])
    expect(panel().querySelector("video")!.getAttribute("poster")).toBe("/clips/build.jpg")
  })

  it("switches the panel on a click", () => {
    render(<Home navigate={vi.fn()} />)
    fireEvent.click(tabs()[1])
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true")
    expect(sources()).toEqual(["/clips/evaluate-dark.webm", "/clips/evaluate.webm"])
    expect(within(panel()).getByText(/Write questions for me reads the document/)).toBeTruthy()
    fireEvent.click(tabs()[2])
    expect(sources()).toEqual(["/clips/compare-dark.webm", "/clips/compare.webm"])
  })

  it("moves with the arrow keys, Home and End, wrapping round, and focuses the new tab", () => {
    render(<Home navigate={vi.fn()} />)
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" })
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(tabs()[1])
    fireEvent.keyDown(tabs()[1], { key: "ArrowLeft" })
    fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" })
    expect(tabs()[3].getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(tabs()[3])
    fireEvent.keyDown(tabs()[3], { key: "ArrowRight" })
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(tabs()[0], { key: "End" })
    expect(tabs()[3].getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(tabs()[3], { key: "Home" })
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true")
  })

  it("Take it home shows the zip's commands and its files, and no clip", () => {
    render(<Home navigate={vi.fn()} />)
    fireEvent.click(tabs()[3])
    expect(panel().querySelector("video")).toBeNull()
    const term = within(panel()).getByLabelText("What the zip holds")
    expect(term.tabIndex).toBe(0)
    expect(term.textContent).toContain("unzip starter.zip && cd starter")
    expect(term.textContent).toContain("pip install -r requirements.txt")
    expect(term.textContent).toContain("python run.py")
    const files = within(panel()).getByRole("list", { name: "The files in the zip" })
    expect(within(files).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "pipeline.yaml",
      "run.py",
      "questions.json",
      "requirements.txt",
      "README.md",
      "docs/",
    ])
  })
})

describe("Home's starts", () => {
  it("offers a sample, your own knowledge and a template", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    const start = region("Start from what you have")
    expect(within(start).getByRole("heading", { level: 3, name: "A sample" })).toBeTruthy()
    expect(await within(start).findByText("Scanned notes")).toBeTruthy()
    expect(within(start).getByText("Two-column report")).toBeTruthy()
    expect(within(start).getByRole("link", { name: "Start from a template" }).getAttribute("href")).toBe("/build?templates=1")
    fireEvent.click(within(start).getByRole("button", { name: "Open a sample on Build" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/build?starter=${FIRST.name}`))
  })

  it("says where your files stay, from the demo's own limits", async () => {
    serve({ settings: DEMO })
    render(<Home navigate={vi.fn()} />)
    const start = region("Start from what you have")
    expect(await within(start).findByText(/On this demo your files stay private to your browser and are deleted after 24 hours\./)).toBeTruthy()
  })

  it("adds a document from a link, by keyboard, and opens Build", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    const start = region("Start from what you have")
    const box = within(start).getByRole("textbox", { name: "Link to a web page or PDF" })
    expect(box.getAttribute("type")).toBe("url")
    expect(within(start).getByText("A link is fetched once and kept like an upload.")).toBeTruthy()
    fireEvent.change(box, { target: { value: "https://example.com/guide.html" } })
    fireEvent.submit(box.closest("form")!)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
    expect(linked).toEqual(["https://example.com/guide.html"])
    expect(documentOf(readStoredGraph(registry))).toEqual({ sha: OWN.sha, filename: "example.com" })
  })

  it("while a link is fetched, the hero's button says Fetching", async () => {
    holdUpload = true
    render(<Home navigate={vi.fn()} />)
    const box = within(region("Start from what you have")).getByRole("textbox", { name: "Link to a web page or PDF" })
    fireEvent.change(box, { target: { value: "https://example.com/guide.html" } })
    fireEvent.submit(box.closest("form")!)
    expect(((await screen.findByRole("button", { name: "Fetching" })) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => releaseUpload())
  })

  it("says why a link was refused and stays on Home", async () => {
    refuseLink = "That address is not on the public internet, so it was not fetched."
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    const start = region("Start from what you have")
    const box = within(start).getByRole("textbox", { name: "Link to a web page or PDF" })
    fireEvent.change(box, { target: { value: "https://10.0.0.1/" } })
    fireEvent.click(within(start).getByRole("button", { name: "Add" }))
    expect((await within(start).findByRole("alert")).textContent).toBe(refuseLink)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("Upload your files opens the file picker", () => {
    render(<Home navigate={vi.fn()} />)
    const input = screen.getByLabelText("Choose your own files") as HTMLInputElement
    const click = vi.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(within(region("Start from what you have")).getByRole("button", { name: "Upload your files" }))
    expect(click).toHaveBeenCalledTimes(1)
  })
})

describe("Home's lessons and Pandion", () => {
  it("lists three lessons, each linking its own entry in Lessons learned", () => {
    render(<Home navigate={vi.fn()} />)
    const lessons = region("What we learned building it")
    expect(within(lessons).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "pdfium gave us lines, not paragraphs",
      "The question used words the document never uses",
      "A new rewrite was searched with the old results",
    ])
    expect(within(lessons).getByRole("link", { name: "Read all the lessons" }).getAttribute("href")).toBe(LESSONS_DOC)
    for (const [name, anchor] of [
      ["pdfium gave us lines, not paragraphs", "pdfium-gave-us-lines-not-paragraphs"],
      ["The question used words the document never uses", "the-question-used-words-the-document-never-uses"],
      ["A new rewrite was searched with the old results", "a-new-rewrite-was-searched-with-the-old-results"],
    ]) {
      expect(within(lessons).getByRole("link", { name }).getAttribute("href")).toBe(`${LESSONS_DOC}#${anchor}`)
    }
  })

  it("shows Pandion's real commands and real output, and links PyPI and GitHub", () => {
    render(<Home navigate={vi.fn()} />)
    const pkg = region("The engine is a Python package")
    const term = within(pkg).getByLabelText("Terminal")
    // It scrolls sideways on a phone, so a keyboard can reach it.
    expect(term.tabIndex).toBe(0)
    for (const line of [
      "$ pip install pandion",
      "$ pandion init my-rag --index text --query balanced --questions questions.json",
      "$ python run.py",
      "Found 11 of 12 (92%). Mean reciprocal rank 0.92.",
    ]) {
      expect(term.textContent).toContain(line)
    }
    expect(within(pkg).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Start a project from a template with pandion init.",
      "Have a model write test questions with pandion questions.",
      "Fail a CI run when a change loses questions, with --baseline.",
    ])
    expect(within(pkg).getByRole("link", { name: "Pandion on PyPI" }).getAttribute("href")).toBe("https://pypi.org/project/pandion/")
    expect(within(pkg).getByRole("link", { name: "Pandion on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/nadeem4/rag-playground/tree/main/packages/pandion",
    )
  })

  it("ends with the footer, outside main", () => {
    render(<Home navigate={vi.fn()} />)
    const footer = screen.getByRole("contentinfo")
    expect(footer.closest("main")).toBeNull()
    expect(within(footer).getByRole("link", { name: "Source on GitHub" }).getAttribute("href")).toBe("https://github.com/nadeem4/rag-playground")
    expect(within(footer).getByRole("link", { name: "Pandion on PyPI" }).getAttribute("href")).toBe("https://pypi.org/project/pandion/")
    expect(within(footer).getByRole("link", { name: "Your data and privacy" }).getAttribute("href")).toBe("/privacy")
  })

  it("has no em-dashes or en-dashes in its copy, on any tab", () => {
    render(<Home navigate={vi.fn()} />)
    for (const tab of screen.getAllByRole("tab")) {
      fireEvent.click(tab)
      expect(document.body.textContent).not.toMatch(/[–—]/)
    }
    const labels = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ")
    expect(labels).not.toMatch(/[–—]/)
  })
})

const pdf = (name = "mine.pdf", type = "application/pdf") => new File(["%PDF-1.4"], name, { type })

describe("Home's own files", () => {
  it("Use your own files opens the file picker straight away, and it takes every format a parser reads", async () => {
    render(<Home navigate={vi.fn()} />)
    const input = screen.getByLabelText("Choose your own files") as HTMLInputElement
    expect(input.type).toBe("file")
    // Every format a parser on the server reads, from the shared upload hook.
    await waitFor(() => expect(input.getAttribute("accept")).toBe(".pdf,.docx,.pptx,.html,.htm,.md,.txt,.png,.jpg,.jpeg"))
    const click = vi.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(screen.getByRole("button", { name: "Use your own files" }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it("uploads the chosen file, makes it the document and opens Build", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.change(screen.getByLabelText("Choose your own files"), { target: { files: [pdf()] } })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
    expect(uploaded).toEqual(["mine.pdf"])
    expect(documentOf(readStoredGraph(registry))).toEqual({ sha: OWN.sha, filename: "mine.pdf" })
  })

  it("says the server's refusal under the buttons, stays on Home and puts focus back on the button", async () => {
    refuseUpload = "This PDF has 40 pages. The hosted demo takes up to 20."
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.change(screen.getByLabelText("Choose your own files"), { target: { files: [pdf()] } })
    expect((await screen.findByRole("alert")).textContent).toBe("Upload of mine.pdf failed: This PDF has 40 pages. The hosted demo takes up to 20.")
    expect(navigate).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use your own files" })))
  })

  it("while an upload runs, the busy button says Uploading and the sample buttons wait", async () => {
    holdUpload = true
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.change(screen.getByLabelText("Choose your own files"), { target: { files: [pdf()] } })
    const own = await screen.findByRole("button", { name: "Uploading" })
    expect((own as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Try a sample" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Open a sample on Build" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => releaseUpload())
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it("names each kind of file and its demo limit under the buttons", async () => {
    serve({ settings: DEMO })
    render(<Home navigate={vi.fn()} />)
    expect(
      await screen.findByText(
        "PDF, Word, PowerPoint, HTML, Markdown, text or images. A PDF up to 10 MB and 20 pages. Other files up to 2 MB. Images up to 5 MB.",
      ),
    ).toBeTruthy()
  })

  it("names each kind of file, with no limits, when running locally", async () => {
    render(<Home navigate={vi.fn()} />)
    expect(await screen.findByText("PDF, Word, PowerPoint, HTML, Markdown, text or images.")).toBeTruthy()
  })

  it("refuses a kind of file no parser reads, naming the kinds it takes", async () => {
    render(<Home navigate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Choose your own files"), { target: { files: [pdf("sheet.xlsx", "application/octet-stream")] } })
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Upload of sheet.xlsx failed: This kind of file cannot be read here. Upload PDF, Word, PowerPoint, HTML, Markdown, text or images.",
    )
    expect(uploaded).toEqual([])
  })

  it("says the file stays on this machine when running locally", async () => {
    render(<Home navigate={vi.fn()} />)
    expect(await screen.findByText("Your files stay on this machine.")).toBeTruthy()
    expect(screen.queryByText(/Private to your browser/)).toBeNull()
  })
})

describe("Home's files", () => {
  it("keeps spacing on the theme's scale, with no arbitrary gap, padding or margin", async () => {
    const { readFileSync } = await import("node:fs")
    const arbitrary = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y)-\[/m
    for (const f of ["routes/Home.tsx", "components/Clip.tsx"]) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(arbitrary)
  })
})
