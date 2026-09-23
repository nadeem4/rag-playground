import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry, SampleQuestion } from "@/api/types"
import { sampleGraph, storeGraph } from "@/state/graph"

import { Evaluate } from "./Evaluate"

const registry = liveRegistry as unknown as Registry
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

const QUESTIONS: SampleQuestion[] = [
  { id: "a", question: "What are the two steps?", gold_answer: "It answers in two steps." },
  { id: "b", question: "How big is a chunk?", gold_answer: "A chunk should answer one question well." },
]

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

function serve(reg: unknown = liveRegistry) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/registry") return ok(reg)
      if (url === "/api/samples/questions") return ok(QUESTIONS)
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

beforeEach(() => {
  window.localStorage.clear()
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
    serve(withoutRetrieve)
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
