import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { AppSettings, Registry, SampleCard, Source } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { documentOf, resetDocumentForTests, useDocument } from "@/state/document"
import { readStoredGraph, resetStoredGraphForTests, sampleGraph, storeGraph, storedGraphJson } from "@/state/graph"

import { Home } from "./Home"

const registry = liveRegistry as unknown as Registry

const FIRST: SampleCard = {
  name: "two-column-report",
  title: "A two-column report",
  blurb: "Two pages laid out in two columns.",
  shows: "Reading order.",
  stresses: "parse",
  pages: 2,
  default: true,
  filename: "two-column-report.pdf",
  sha: "cd".repeat(32),
  question: "How long did the survey run?",
}
const SECOND: SampleCard = { ...FIRST, name: "chunking-primer", filename: "chunking-primer.pdf", sha: "ef".repeat(32), default: false, question: "How big is a chunk?" }
const OWN: Source = { sha: "ab".repeat(32), filename: "mine.pdf", size: 2048, content_type: "application/pdf" }

let posted: string[] = []
let uploaded: string[] = []

const DEMO = {
  demo: true,
  limits: { max_bytes: 10485760, max_pages: 20, max_files: 3, max_total_bytes: 31457280, ttl_hours: 24 },
} as AppSettings

function serve({ settings = { demo: false } as AppSettings, sources = [] as Source[] | "never" } = {}) {
  posted = []
  uploaded = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/samples") return ok([FIRST, SECOND])
      if (url === "/api/sources" && init?.method === "POST") {
        const file = (init.body as FormData).get("file") as File
        uploaded.push(file.name)
        return ok({ ...OWN, filename: file.name })
      }
      if (url === "/api/sources") return sources === "never" ? new Promise<Response>(() => {}) : ok(sources)
      if (url === "/api/settings/app") return ok(settings)
      if (url === "/api/sources/sample" && init?.method === "POST") {
        const name = JSON.parse(String(init.body ?? "{}")).name as string
        posted.push(name)
        const card = [FIRST, SECOND].find((c) => c.name === name)!
        return ok({ sha: card.sha, filename: card.filename, size: 1000, content_type: "application/pdf" })
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
  serve()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Home", () => {
  it("opens with the promise, the two buttons and the three facts", () => {
    render(<Home navigate={vi.fn()} />)
    expect(screen.getByText("Retrieval, made visible")).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1, name: "See why a RAG pipeline finds the answer, or misses it." })).toBeTruthy()
    expect(screen.getByText(/Load a PDF, cut it into pieces, search it and ask it a question\./)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try a sample" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Use your own PDF" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "See how it works" }).getAttribute("href")).toBe("#build")
    for (const fact of ["No sign in", "Runs on samples or your own PDF", "A key is only needed for chat answers"]) expect(screen.getByText(fact)).toBeTruthy()
  })

  it("makes every call to action 44 px tall, with no smaller height left to win", () => {
    render(<Home navigate={vi.fn()} />)
    const ctas = [
      screen.getByRole("button", { name: "Try a sample" }),
      screen.getByRole("button", { name: "Use your own PDF" }),
      ...["Build", "Compare", "Evaluate"].map((p) => screen.getByRole("button", { name: `Try it yourself on ${p}` })),
    ]
    for (const el of ctas) {
      const c = el.className.split(/\s+/)
      expect(c).toContain("h-[44px]")
      expect(c).not.toContain("h-control")
    }
  })

  it("names the six steps from Document to Ask, in order", () => {
    render(<Home navigate={vi.fn()} />)
    const strip = screen.getByRole("list", { name: "The steps you can look inside" })
    const steps = within(strip)
      .getAllByRole("listitem")
      .map((li) => li.firstElementChild!.textContent)
    expect(steps).toEqual(["Document", "Parse", "Clean", "Chunk", "Index", "Ask"])
  })

  it("has one section each for Build, Compare and Evaluate, counted 1 to 3, with alternating sides", () => {
    render(<Home navigate={vi.fn()} />)
    const names = ["Build a pipeline and ask it", "Compare recipes on the same document", "Evaluate it on real questions"]
    const sections = names.map((name) => screen.getByRole("region", { name }))
    sections.forEach((s, i) => {
      expect(within(s).getByText(`${i + 1} of 3`)).toBeTruthy()
      expect(within(s).getAllByRole("listitem")).toHaveLength(2)
      expect(within(s).getByRole("figure")).toBeTruthy()
    })
    // The middle section puts its words on the right from lg up.
    expect(sections[1].querySelector("[data-copy]")!.className).toContain("lg:order-2")
    expect(sections[0].querySelector("[data-copy]")!.className).not.toContain("lg:order-2")
  })

  it("stacks each section full width until lg, so the clip is readable at 768", () => {
    render(<Home navigate={vi.fn()} />)
    for (const name of ["Build a pipeline and ask it", "Compare recipes on the same document", "Evaluate it on real questions"]) {
      const c = screen.getByRole("region", { name }).className.split(/\s+/)
      expect(c).toContain("grid-cols-1")
      expect(c.some((k) => k.startsWith("lg:grid-cols-["))).toBe(true)
      expect(c.some((k) => k.startsWith("md:grid-cols-"))).toBe(false)
      const copy = screen.getByRole("region", { name }).querySelector("[data-copy]")!.className
      expect(copy).not.toContain("md:order-2")
    }
  })

  it("lists each section's points as a bulleted list at 1rem", () => {
    render(<Home navigate={vi.fn()} />)
    const list = within(screen.getByRole("region", { name: "Build a pipeline and ask it" })).getByRole("list").className.split(/\s+/)
    for (const k of ["list-disc", "pl-4", "text-[1rem]"]) expect(list).toContain(k)
  })

  it("sets the eyebrow at weight 700", () => {
    render(<Home navigate={vi.fn()} />)
    expect(screen.getByText("Retrieval, made visible").className.split(/\s+/)).toContain("font-[700]")
  })

  it.each([
    ["Build", "/build"],
    ["Compare", "/compare"],
    ["Evaluate", "/evaluate"],
  ])("Try it yourself on %s loads the first sample when there is no document, then opens %s", async (page, href) => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: `Try it yourself on ${page}` }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(href))
    expect(posted).toEqual([FIRST.name])
    const g = readStoredGraph(registry)!
    expect(documentOf(g)).toEqual({ sha: FIRST.sha, filename: FIRST.filename })
    // The sample's own question is set, so the first run asks something real.
    expect(g.nodes.find((n) => n.stage === "query")!.config.text).toBe(FIRST.question)
  })

  it("Try a sample opens Build with the first sample", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Try a sample" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
    expect(posted).toEqual([FIRST.name])
  })

  it("keeps the visitor's own document and just opens the page", async () => {
    storeGraph(sampleGraph(registry, OWN))
    const before = storedGraphJson()
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Try it yourself on Evaluate" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/evaluate"))
    expect(posted).toEqual([])
    expect(storedGraphJson()).toBe(before)
  })

  it("still opens the page when the sample cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "down" }), { status: 500 })))
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Try it yourself on Build" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
  })

  it("shows a clip for Build, Compare and Evaluate, each in light and dark", () => {
    render(<Home navigate={vi.fn()} />)
    const videos = document.querySelectorAll("video")
    expect([...videos].map((v) => [...v.querySelectorAll("source")].map((s) => s.getAttribute("src")))).toEqual([
      ["/clips/build-dark.webm", "/clips/build.webm"],
      ["/clips/compare-dark.webm", "/clips/compare.webm"],
      ["/clips/evaluate-dark.webm", "/clips/evaluate.webm"],
    ])
    expect([...videos].map((v) => v.getAttribute("poster"))).toEqual(["/clips/build.jpg", "/clips/compare.jpg", "/clips/evaluate.jpg"])
    const compare = screen.getByRole("region", { name: "Compare recipes on the same document" })
    expect(within(compare).getByRole("figure", { name: "Clip: running three recipes on Compare and reading what changed" })).toBeTruthy()
    expect(within(compare).getByText("Run three recipes and read what changed")).toBeTruthy()
    expect(screen.queryByText("Clip coming soon")).toBeNull()
  })

  it("describes the Compare page as it is now", () => {
    render(<Home navigate={vi.fn()} />)
    const compare = screen.getByRole("region", { name: "Compare recipes on the same document" })
    expect(within(compare).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Save the set as an experiment and come back to it.",
      "Up to ten recipes; open any three side by side.",
    ])
  })

  it("links Read, running it on your machine and the source, then the footer", () => {
    render(<Home navigate={vi.fn()} />)
    const more = screen.getByRole("region", { name: "More" })
    expect(within(more).getByRole("link", { name: "Read" }).getAttribute("href")).toBe("/read")
    expect(within(more).getByRole("link", { name: "Run it on your machine" }).getAttribute("href")).toBe(
      "https://github.com/nadeem4/rag-playground#quick-start",
    )
    expect(within(more).getByRole("link", { name: "Source on GitHub" }).getAttribute("href")).toBe("https://github.com/nadeem4/rag-playground")
    const footer = screen.getByRole("contentinfo")
    // A footer inside main is not a contentinfo landmark in a browser.
    expect(footer.tagName).toBe("FOOTER")
    expect(footer.closest("main")).toBeNull()
    for (const name of ["Read", "Run it on your machine", "Source on GitHub"]) {
      const c = within(more).getByRole("link", { name }).className.split(/\s+/)
      for (const k of ["inline-flex", "min-h-[44px]", "items-center"]) expect(c).toContain(k)
    }
    expect(within(footer).getByRole("link", { name: "Your data and privacy" }).getAttribute("href")).toBe("/privacy")
    expect(within(footer).getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/nadeem4/rag-playground")
  })

  it("has no em-dashes or en-dashes in its copy", () => {
    render(<Home navigate={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/[–—]/)
    const labels = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ")
    expect(labels).not.toMatch(/[–—]/)
  })
})

const pdf = (name = "mine.pdf", type = "application/pdf") => new File(["%PDF-1.4"], name, { type })

describe("Home's own PDF", () => {
  it("keeps See how it works as a quiet text link, 44 px tall", () => {
    render(<Home navigate={vi.fn()} />)
    const link = screen.getByRole("link", { name: "See how it works" })
    expect(link.getAttribute("data-slot")).toBeNull()
    expect(link.className.split(/\s+/)).toContain("min-h-[44px]")
  })

  it("Use your own PDF opens the file picker straight away", () => {
    render(<Home navigate={vi.fn()} />)
    const input = screen.getByLabelText("Choose your own PDF") as HTMLInputElement
    expect(input.type).toBe("file")
    const click = vi.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(screen.getByRole("button", { name: "Use your own PDF" }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it("uploads the chosen PDF, makes it the document and opens Build", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.change(screen.getByLabelText("Choose your own PDF"), { target: { files: [pdf()] } })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/build"))
    expect(uploaded).toEqual(["mine.pdf"])
    expect(posted).toEqual([])
    expect(documentOf(readStoredGraph(registry))).toEqual({ sha: OWN.sha, filename: "mine.pdf" })
  })

  it("says why an upload was refused under the buttons, stays on Home and puts focus back on the button", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.change(screen.getByLabelText("Choose your own PDF"), { target: { files: [pdf("notes.txt", "text/plain")] } })
    expect((await screen.findByRole("alert")).textContent).toBe("Upload of notes.txt failed: Only PDF files can be uploaded.")
    expect(navigate).not.toHaveBeenCalled()
    expect(uploaded).toEqual([])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use your own PDF" })))
  })

  it("states the demo's real limits under the buttons", async () => {
    serve({ settings: DEMO })
    render(<Home navigate={vi.fn()} />)
    expect(await screen.findByText("Up to 20 pages and 10 MB. Private to your browser and deleted after 24 hours.")).toBeTruthy()
    expect(screen.queryByText("Your file stays on this machine.")).toBeNull()
  })

  it("says the file stays on this machine when running locally", async () => {
    render(<Home navigate={vi.fn()} />)
    expect(await screen.findByText("Your file stays on this machine.")).toBeTruthy()
    expect(screen.queryByText(/Private to your browser/)).toBeNull()
  })
})

function MenuProbe() {
  return <span data-testid="menu">{useDocument().menuOpen ? "open" : "closed"}</span>
}

const lines = () => screen.queryAllByTestId("home-document").map((el) => el.firstElementChild!.textContent)

describe("Home's document line", () => {
  it("names the first sample under each Try it yourself when there is no document", async () => {
    render(<Home navigate={vi.fn()} />)
    await waitFor(() => expect(lines()).toEqual(Array(3).fill("On the sample: two-column-report.pdf")))
  })

  it("names the sample that is loaded", async () => {
    storeGraph(sampleGraph(registry, { sha: SECOND.sha, filename: SECOND.filename }))
    render(<Home navigate={vi.fn()} />)
    await waitFor(() => expect(lines()).toEqual(Array(3).fill("On the sample: chunking-primer.pdf")))
  })

  it("names the visitor's own upload", async () => {
    serve({ sources: [OWN] })
    storeGraph(sampleGraph(registry, OWN))
    render(<Home navigate={vi.fn()} />)
    await waitFor(() => expect(lines()).toEqual(Array(3).fill("On your file: mine.pdf")))
  })

  it("says, in the stale tone, when the upload is gone on the demo", async () => {
    serve({ settings: DEMO })
    storeGraph(sampleGraph(registry, OWN))
    render(<Home navigate={vi.fn()} />)
    await waitFor(() => expect(lines()).toEqual(Array(3).fill("mine.pdf is no longer on the demo.")))
    expect(screen.getAllByTestId("home-document")[0].className.split(/\s+/)).toContain("text-stale")
  })

  it("says the upload is gone from this machine when running locally", async () => {
    storeGraph(sampleGraph(registry, OWN))
    render(<Home navigate={vi.fn()} />)
    await waitFor(() => expect(lines()).toEqual(Array(3).fill("mine.pdf is no longer on this machine.")))
  })

  it("shows nothing while the document is being checked, so it does not flicker", async () => {
    serve({ sources: "never" })
    storeGraph(sampleGraph(registry, OWN))
    render(<Home navigate={vi.fn()} />)
    await act(async () => {})
    expect(lines()).toEqual([])
  })

  it("Change opens the Document menu, named for its page, 44 px tall", async () => {
    render(
      <>
        <MenuProbe />
        <Home navigate={vi.fn()} />
      </>,
    )
    const change = await screen.findByRole("button", { name: "Change the document for Compare" })
    expect(screen.getByRole("button", { name: "Change the document for Build" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Change the document for Evaluate" })).toBeTruthy()
    expect(change.textContent).toBe("Change")
    expect(change.className.split(/\s+/)).toContain("min-h-[44px]")
    expect(screen.getByTestId("menu").textContent).toBe("closed")
    fireEvent.click(change)
    expect(screen.getByTestId("menu").textContent).toBe("open")
  })
})

describe("Home's files", () => {
  it("keeps spacing on the theme's scale, with no arbitrary gap, padding or margin", async () => {
    const { readFileSync } = await import("node:fs")
    const arbitrary = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y)-\[/m
    for (const f of ["routes/Home.tsx", "components/Clip.tsx"]) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(arbitrary)
  })
})
