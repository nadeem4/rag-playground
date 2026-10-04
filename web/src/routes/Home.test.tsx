import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry, SampleCard, Source } from "@/api/types"
import { documentOf, resetDocumentForTests } from "@/state/document"
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

function serve() {
  posted = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/samples") return ok([FIRST, SECOND])
      if (url === "/api/sources") return ok([])
      if (url === "/api/settings/app") return ok({ demo: false })
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
    expect(screen.getByRole("button", { name: "Try it on a sample" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "See how it works" }).getAttribute("href")).toBe("#build")
    for (const fact of ["No sign in", "Runs on samples or your own PDF", "A key is only needed for chat answers"]) expect(screen.getByText(fact)).toBeTruthy()
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
    // The middle section puts its words on the right from md up.
    expect(sections[1].querySelector("[data-copy]")!.className).toContain("md:order-2")
    expect(sections[0].querySelector("[data-copy]")!.className).not.toContain("md:order-2")
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

  it("Try it on a sample opens Build with the first sample", async () => {
    const navigate = vi.fn()
    render(<Home navigate={navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Try it on a sample" }))
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

  it("links Read, running it on your machine and the source, then the footer", () => {
    render(<Home navigate={vi.fn()} />)
    const more = screen.getByRole("region", { name: "More" })
    expect(within(more).getByRole("link", { name: "Read" }).getAttribute("href")).toBe("/read")
    expect(within(more).getByRole("link", { name: "Run it on your machine" }).getAttribute("href")).toBe(
      "https://github.com/nadeem4/rag-playground#quick-start",
    )
    expect(within(more).getByRole("link", { name: "Source on GitHub" }).getAttribute("href")).toBe("https://github.com/nadeem4/rag-playground")
    const footer = screen.getByRole("contentinfo")
    expect(within(footer).getByRole("link", { name: "Your data and privacy" })).toBeTruthy()
    expect(within(footer).getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/nadeem4/rag-playground")
  })

  it("has no em-dashes or en-dashes in its copy", () => {
    render(<Home navigate={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/[–—]/)
    const labels = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ")
    expect(labels).not.toMatch(/[–—]/)
  })
})

describe("Home's files", () => {
  const files = ["routes/Home.tsx"]

  it("uses only spacing steps the theme defines (0, 1, 2, 3, 4, 6, 8), since any other step compiles to nothing", async () => {
    const { readFileSync } = await import("node:fs")
    const offScale = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(offScale)
  })

  it("uses no sm: or 2xl: class, since the theme has only md, lg and xl", async () => {
    const { readFileSync } = await import("node:fs")
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(/(^|[\s"'`])(?:sm|2xl|max-sm):/m)
  })
})
