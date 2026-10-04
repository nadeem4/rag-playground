import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { decodePipeline } from "@/state/pipelines"

import { Read, TRY_IT_ENABLED, tryLink } from "./Read"

const registry = liveRegistry as unknown as Registry
const PRIMER_SHA = "cd".repeat(32)
const COLUMNS_SHA = "ab".repeat(32)

const sample = (name: string, sha: string, question = "What is it about?") => ({
  name,
  title: name,
  blurb: "",
  shows: "",
  stresses: "parse",
  pages: 3,
  default: false,
  filename: `${name}.pdf`,
  sha,
  question,
})

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/registry") return ok(registry)
      if (url === "/api/samples") return ok([sample("chunking-primer", PRIMER_SHA, "Why do chunk boundaries matter?"), sample("two-column-report", COLUMNS_SHA, "What does the report recommend?")])
      return new Response("not found", { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const section = (title: string) => screen.getByRole("region", { name: title })

describe("Read", () => {
  it("shows the header and ten sections in pipeline order", async () => {
    render(<Read />)
    expect(await screen.findByRole("heading", { level: 1, name: "Read, then try it" })).toBeTruthy()
    expect(screen.getByText("The posts behind each step, in pipeline order.")).toBeTruthy()
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(titles).toEqual(["Overview", "Upload", "Parse", "Clean", "Chunk", "Index", "Retrieve", "Rerank", "Answer", "Evaluate"])
  })

  it("sets the page on the scale: 32 px rhythm between sections, text-lg post titles", async () => {
    render(<Read />)
    await screen.findByRole("heading", { level: 1, name: "Read, then try it" })
    expect(section("Chunk").className).toContain("py-8")
    const link = within(section("Chunk")).getAllByRole("link")[0]
    expect(link.className).toContain("text-lg")
    expect(link.className).toContain("font-serif")
    // The one-line summary and the date stay in the tool's voice.
    const item = link.closest("li") as HTMLElement
    for (const p of Array.from(item.querySelectorAll("p"))) expect(p.className).not.toContain("font-serif")
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("learn-display")
  })

  it("lists the three Chunk posts as external links with the date in words", async () => {
    render(<Read />)
    await screen.findByRole("heading", { level: 1 })
    const chunk = section("Chunk")
    const links = within(chunk).getAllByRole("link").filter((a) => a.getAttribute("target") === "_blank")
    expect(links.map((a) => a.textContent)).toEqual([
      "Chunking Fundamentals: What Chunk Size Actually Trades Off",
      "Advanced Chunking: Parent-Child, Contextual Retrieval, Late Chunking and Hierarchical Summaries",
      "Metadata and Enrichment: What to Store Beside Each Chunk",
    ])
    expect(within(chunk).getByText("30 September 2026")).toBeTruthy()
  })

  it("every post link opens in a new tab without a referrer and points at the owner's post", async () => {
    render(<Read />)
    const chunk = await screen.findByRole("region", { name: "Chunk" })
    const links = within(chunk).getAllByRole("link", { name: /Chunking Fundamentals|Advanced Chunking|Metadata and Enrichment/ })
    expect(links).toHaveLength(3)
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank")
      expect(a.getAttribute("rel")).toBe("noreferrer")
      expect(a.getAttribute("href")).toMatch(/^https:\/\/medium\.com\/learnwithnk\//)
    }
  })

  it("says Rerank has no post yet", async () => {
    render(<Read />)
    await screen.findByRole("heading", { level: 1 })
    expect(within(section("Rerank")).getByText("No post on this yet.")).toBeTruthy()
  })

  it("shows no Try it on Build buttons while the switch is off, and still opens Evaluate", async () => {
    render(<Read />)
    await screen.findByRole("region", { name: "Chunk" })
    expect(TRY_IT_ENABLED).toBe(false)
    expect(screen.queryByRole("link", { name: "Try it on Build" })).toBeNull()
    expect(within(section("Evaluate")).getByRole("link", { name: "Open Evaluate" }).getAttribute("href")).toBe("/evaluate")
  })

  it("the link builder still opens Build on the stage's sample with its own question", () => {
    const columns = { name: "two-column-report", title: "Two-column report", blurb: "", shows: "", stresses: "parse" as const, pages: 3, default: false, filename: "two-column-report.pdf", sha: COLUMNS_SHA, question: "What does the report recommend?" }
    const href = tryLink(registry, columns, "Parse")
    expect(href.startsWith("/build?pipeline=")).toBe(true)
    const decoded = decodePipeline(href.slice("/build?pipeline=".length), registry)!
    expect(decoded.name).toBe("Read: Parse")
    expect(decoded.graph.nodes.find((n) => n.stage === "source")!.config.sha).toBe(COLUMNS_SHA)
    expect(decoded.graph.nodes.find((n) => n.stage === "query")!.config.text).toBe("What does the report recommend?")
  })

  it("our own words have no em-dash or en-dash", async () => {
    const { container } = render(<Read />)
    await screen.findByRole("heading", { level: 1 })
    const clone = container.cloneNode(true) as HTMLElement
    // Post titles are the owner's and stay verbatim.
    clone.querySelectorAll('a[target="_blank"]').forEach((a) => a.remove())
    expect(clone.textContent).not.toMatch(/[–—]/)
  })
})
