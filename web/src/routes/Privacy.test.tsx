import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import { SiteFooter } from "@/components/SiteFooter"
import { resetExperimentsForTests } from "@/state/experiments"
import { resetDocumentForTests } from "@/state/document"
import { EXPERIMENTS_KEY } from "@/state/libraryExperiments"
import { readPipelines, resetPipelinesForTests } from "@/state/pipelines"

import { Privacy } from "./Privacy"

const UP = "ab".repeat(32)
const SAMPLE = "cd".repeat(32)
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const LIMITS = { max_bytes: 10 * 1024 * 1024, max_pages: 20, max_files: 3, max_total_bytes: 200 * 1024 * 1024, ttl_hours: 24 }

let demo = true
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  resetPipelinesForTests()
  resetExperimentsForTests()
  resetDocumentForTests()
  resetAppSettingsForTests()
  demo = true
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/app") return ok(demo ? { demo: true, limits: LIMITS } : { demo: false })
    if (url === "/api/samples") return ok([{ sha: SAMPLE, filename: "primer.pdf", name: "primer" }])
    if (url === `/api/sources/${UP}` && init?.method === "DELETE") return ok({ sha: UP, deleted: true })
    if (url === "/api/sources") return ok([{ sha: UP, filename: "mine.pdf", size: 1, content_type: "application/pdf", uploaded_at: new Date().toISOString() }])
    return new Response("not found", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const table = (name: string) => screen.getByRole("table", { name })
const rowFor = (t: HTMLElement, what: string) => within(t).getByRole("row", { name: new RegExp(`^${what}`) })

describe("Your data and privacy", () => {
  it("lays out what is kept in this browser and on the demo server, with true numbers", async () => {
    render(<Privacy />)
    expect(screen.getByRole("heading", { level: 1, name: "Your data and privacy" })).toBeTruthy()
    const server = await screen.findByRole("table", { name: "On the demo server" })
    expect(rowFor(server, "PDFs you upload").textContent).toContain("24 hours, then deleted. At most 3 files at a time, 10 MB and 20 pages each.")
    expect(rowFor(server, "An anonymous browser id").textContent).toContain("rag_visitor")
    expect(rowFor(server, "An anonymous browser id").textContent).toContain("One year.")
    expect(rowFor(server, "Run results").textContent).toContain("until the demo restarts or the cache is cleared")
    const browser = table("In this browser")
    for (const what of ["Saved pipelines and experiments", "The pipeline you are working on", "Theme and contrast", "Where the Ask panel sits on Build", "A question set you upload for Evaluate", "Your last evaluation", "API keys you add"]) {
      expect(rowFor(browser, what)).toBeTruthy()
    }
    expect(rowFor(browser, "A question set you upload for Evaluate").textContent).toContain("In this tab only")
    expect(rowFor(browser, "API keys you add").textContent).toContain("never written to storage, a cookie, a link or a saved file")
  })

  it("names the Hugging Face terms that cover the hosting", async () => {
    render(<Privacy />)
    await screen.findByRole("table", { name: "On the demo server" })
    expect(screen.getByRole("link", { name: "privacy policy" }).getAttribute("href")).toBe("https://huggingface.co/privacy")
    expect(screen.getByRole("link", { name: "terms" }).getAttribute("href")).toBe("https://huggingface.co/terms-of-service")
    expect(screen.getByRole("heading", { level: 2, name: "What is never kept" })).toBeTruthy()
  })

  it("says on this machine when running locally, with no demo cleanup", async () => {
    demo = false
    render(<Privacy />)
    const machine = await screen.findByRole("table", { name: "On this machine" })
    expect(rowFor(machine, "PDFs you upload").textContent).toContain("Until you delete them. Nothing expires on your machine.")
    expect(screen.queryByRole("table", { name: "On the demo server" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete my uploads from the demo" })).toBeNull()
    expect(screen.queryByRole("link", { name: "privacy policy" })).toBeNull()
  })

  it("asks on the page before deleting saved pipelines and experiments, then clears both", async () => {
    window.localStorage.setItem("rag-playground:pipelines:v1", JSON.stringify([{ id: "p1", name: "One", graph: { nodes: [], edges: [] }, savedAt: "2026-10-01T00:00:00Z" }]))
    window.localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify([{ id: "e1", name: "E", stage: "chunk", recipes: [{ transform: "recursive_character", config: {} }], doc: null, savedAt: "2026-10-01T00:00:00Z" }]))
    const confirm = vi.fn(() => true)
    vi.stubGlobal("confirm", confirm)
    render(<Privacy />)
    fireEvent.click(screen.getByRole("button", { name: "Delete saved pipelines and experiments" }))
    const ask = screen.getByRole("group", { name: "Confirm deleting saved items" })
    expect(ask.textContent).toContain("1 saved pipeline and 1 experiment")
    expect(readPipelines()).toHaveLength(1)
    fireEvent.click(within(ask).getByRole("button", { name: "Delete them" }))
    expect(readPipelines()).toEqual([])
    expect(window.localStorage.getItem(EXPERIMENTS_KEY)).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByText("Deleted every saved pipeline and experiment in this browser.")).toBeTruthy()
  })

  it("deletes this browser's uploads from the demo through the server, after asking", async () => {
    render(<Privacy />)
    await screen.findByRole("table", { name: "On the demo server" })
    fireEvent.click(screen.getByRole("button", { name: "Delete my uploads from the demo" }))
    const ask = await screen.findByRole("group", { name: "Confirm deleting uploads" })
    expect(ask.textContent).toContain("mine.pdf")
    fireEvent.click(within(ask).getByRole("button", { name: "Delete them" }))
    await waitFor(() => expect(screen.getByText("Deleted 1 upload from the demo.")).toBeTruthy())
    expect(fetchMock.mock.calls.some(([u, i]) => u === `/api/sources/${UP}` && i?.method === "DELETE")).toBe(true)
  })

  it("says saved items leave only by export or a share link, that page images may stay in the cache, and why results go on a restart", async () => {
    render(<Privacy />)
    await screen.findByRole("table", { name: "On the demo server" })
    const browser = table("In this browser")
    expect(rowFor(browser, "Saved pipelines and experiments").textContent).toContain("never leave this browser unless you export them or share a link")
    expect(rowFor(browser, "Page images you viewed").textContent).toContain("may stay in this browser's cache until it is cleared")
    expect(rowFor(table("On the demo server"), "Run results").textContent).toContain("since the demo runs without persistent storage")
    expect(document.body.textContent).not.toContain("lasting disk")
  })

  it("waits for the samples list before deleting uploads, and never sends a sample", async () => {
    let answerSamples: (r: Response) => void = () => {}
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/app") return ok({ demo: true, limits: LIMITS })
      if (url === "/api/samples") return new Promise<Response>((r) => (answerSamples = r))
      if (url.startsWith("/api/sources/") && init?.method === "DELETE") return ok({ sha: UP, deleted: true })
      if (url === "/api/sources")
        return ok([
          { sha: UP, filename: "mine.pdf", size: 1, content_type: "application/pdf", uploaded_at: new Date().toISOString() },
          { sha: SAMPLE, filename: "primer.pdf", size: 1, content_type: "application/pdf" },
        ])
      return new Response("not found", { status: 404 })
    })
    render(<Privacy />)
    await screen.findByRole("table", { name: "On the demo server" })
    const button = screen.getByRole("button", { name: "Delete my uploads from the demo" })
    expect(button).toHaveProperty("disabled", true)
    answerSamples(ok([{ sha: SAMPLE, filename: "primer.pdf", name: "primer" }]))
    await waitFor(() => expect(button).toHaveProperty("disabled", false))
    fireEvent.click(button)
    const ask = await screen.findByRole("group", { name: "Confirm deleting uploads" })
    expect(ask.textContent).not.toContain("primer.pdf")
    fireEvent.click(within(ask).getByRole("button", { name: "Delete them" }))
    await waitFor(() => expect(screen.getByText("Deleted 1 upload from the demo.")).toBeTruthy())
    expect(fetchMock.mock.calls.some(([u, i]) => u === `/api/sources/${SAMPLE}` && i?.method === "DELETE")).toBe(false)
  })

  it("has a site footer that links Privacy", () => {
    render(<SiteFooter />)
    const footer = screen.getByRole("contentinfo")
    expect(within(footer).getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy")
  })

  it("uses only the theme's spacing steps and breakpoints, and no dashes, in its files", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Privacy.tsx", "components/SiteFooter.tsx"]
    const offScale = /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
    for (const f of files) {
      const src = readFileSync(`${__dirname}/../${f}`, "utf8")
      expect(src, f).not.toMatch(offScale)
      expect(src, f).not.toMatch(/(^|[\s"'`])(?:sm|2xl|max-sm):/m)
      expect(src, f).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
