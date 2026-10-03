import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { decodePipeline } from "@/state/pipelines"

import { Read } from "./Read"

const registry = liveRegistry as unknown as Registry
const PRIMER_SHA = "cd".repeat(32)
const COLUMNS_SHA = "ab".repeat(32)

const sample = (name: string, sha: string) => ({
  name,
  title: name,
  blurb: "",
  shows: "",
  stresses: "parse",
  pages: 3,
  default: false,
  filename: `${name}.pdf`,
  sha,
  question: "What is it about?",
})

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/registry") return ok(registry)
      if (url === "/api/samples") return ok([sample("chunking-primer", PRIMER_SHA), sample("two-column-report", COLUMNS_SHA)])
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
    expect(screen.getByText("The posts behind each step, in pipeline order. Each one opens Build ready for that step.")).toBeTruthy()
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(titles).toEqual(["Overview", "Upload", "Parse", "Clean", "Chunk", "Index", "Retrieve", "Rerank", "Answer", "Evaluate"])
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

  it("says Rerank has no post yet", async () => {
    render(<Read />)
    await screen.findByRole("heading", { level: 1 })
    expect(within(section("Rerank")).getByText("No post on this yet.")).toBeTruthy()
  })

  it("the Chunk button opens Build on the primer", async () => {
    render(<Read />)
    const button = await within(await screen.findByRole("region", { name: "Chunk" })).findByRole("link", { name: "Try it on Build" })
    const href = button.getAttribute("href")!
    expect(href.startsWith("/build?pipeline=")).toBe(true)
    const decoded = decodePipeline(href.slice("/build?pipeline=".length), registry)!
    expect(decoded.name).toBe("Read: Chunk")
    expect(decoded.graph.nodes.find((n) => n.stage === "source")!.config.sha).toBe(PRIMER_SHA)
  })

  it("the Parse button uses the two-column report, Evaluate opens Evaluate, the Overview has no button", async () => {
    render(<Read />)
    const parse = await within(await screen.findByRole("region", { name: "Parse" })).findByRole("link", { name: "Try it on Build" })
    const decoded = decodePipeline(parse.getAttribute("href")!.slice("/build?pipeline=".length), registry)!
    expect(decoded.graph.nodes.find((n) => n.stage === "source")!.config.sha).toBe(COLUMNS_SHA)
    expect(within(section("Evaluate")).getByRole("link", { name: "Open Evaluate" }).getAttribute("href")).toBe("/evaluate")
    expect(within(section("Overview")).queryByRole("link", { name: "Try it on Build" })).toBeNull()
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
