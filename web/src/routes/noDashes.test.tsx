import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import liveStages from "@/api/fixtures/stages.json"
import chunkSet from "@/api/fixtures/chunk_set.recursive_character.json"
import indexDescriptor from "@/api/fixtures/index.lancedb.json"
import chat from "@/api/fixtures/output.chat.json"
import chatSentenceIds from "@/api/fixtures/output.chat.sentence_ids.json"
import search from "@/api/fixtures/output.search.json"
import parsedDoc from "@/api/fixtures/parsed_doc.json"
import retrieval from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { Registry, Source } from "@/api/types"
import { resetStagesCache } from "@/api/useExplain"
import { ArtifactInspector } from "@/components/inspectors/registry"
import { sampleGraph, storeGraph } from "@/state/graph"

import { Compare } from "./Compare"
import { Evaluate } from "./Evaluate"
import { Shell } from "./Shell"

/**
 * Contract §10: zero em-dashes and en-dashes in any visible string. This
 * renders the main Build, Compare and Evaluate views, and the inspectors they
 * show, against the live registry and stage text, and fails on either character.
 */

const DASH = /[–—]/
const SOURCE: Source = { sha: "ab".repeat(32), filename: "report.pdf", size: 2048, content_type: "application/pdf" }
const registry = liveRegistry as unknown as Registry

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

function serve(sources: Source[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/stages") return ok(liveStages)
      if (url === "/api/sources") return ok(sources)
      if (url === "/api/explain") return ok({ settings: "Splits on paragraphs first.", blocking: false })
      if (url === "/api/samples/questions") return ok([{ id: "a", question: "How big is a chunk?", gold_answer: "One question well." }])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

const visibleText = () => document.body.textContent ?? ""

beforeEach(() => {
  window.localStorage.clear()
  resetStagesCache()
  vi.stubGlobal("EventSource", SilentEventSource)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("no em-dashes or en-dashes in visible text", () => {
  it("Build, with a file loaded, Learn mode on and an explanation open", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    serve([SOURCE])
    render(<Shell />)
    const chunk = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-node-id="chunk"]')
      if (!el) throw new Error("the Chunk card has not rendered")
      return el
    })
    await waitFor(() => expect(visibleText()).toMatch(/What is chunking\?/))
    fireEvent.click(within(chunk).getByRole("button", { name: "Explain the Chunk step" }))
    await waitFor(() => expect(visibleText()).toMatch(/What this step does/))
    expect(visibleText()).not.toMatch(DASH)
  })

  it("Build, on a first visit", async () => {
    // The page before this one can still write its graph back as a request it
    // started settles, which lands after `beforeEach` has cleared storage. The
    // slate is wiped here instead, right before the page that needs it empty.
    window.localStorage.clear()
    serve([])
    render(<Shell />)
    await waitFor(() => expect(visibleText()).toMatch(/Try the sample document/))
    expect(visibleText()).not.toMatch(DASH)
  })

  it("Compare, before a sweep", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    serve([SOURCE])
    render(<Compare />)
    await waitFor(() => expect(visibleText()).toMatch(/Sweep \d+ variants?/))
    expect(visibleText()).toMatch(/Not swept yet/)
    expect(visibleText()).not.toMatch(DASH)
  })

  it("Compare, with no pipeline", async () => {
    serve([])
    render(<Compare />)
    await waitFor(() => expect(visibleText()).toMatch(/No pipeline to compare/))
    expect(visibleText()).not.toMatch(DASH)
  })

  it("Evaluate, before a run", async () => {
    storeGraph(sampleGraph(registry, SOURCE))
    serve([SOURCE])
    render(<Evaluate />)
    await waitFor(() => expect(visibleText()).toMatch(/questions? ready/))
    expect(visibleText()).toMatch(/Nothing scored yet/)
    expect(visibleText()).not.toMatch(DASH)
  })

  it.each([
    ["parsed_doc", parsedDoc, undefined],
    ["chunk_set", chunkSet, { doc: parsedDoc }],
    ["index", indexDescriptor, undefined],
    ["retrieval_result", retrieval, { chunks: chunkSet }],
    ["output", search, { chunks: chunkSet }],
    ["output", chat, { chunks: chunkSet }],
    ["output", chatSentenceIds, { chunks: chunkSet }],
  ])("the %s inspector", (type, data, context) => {
    render(<ArtifactInspector type={type} data={data} status={{ kind: "ready" }} context={context as never} />)
    expect(visibleText().length).toBeGreaterThan(0)
    expect(visibleText()).not.toMatch(DASH)
  })
})
