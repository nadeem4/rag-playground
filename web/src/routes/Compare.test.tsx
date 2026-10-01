import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { sampleGraph, storeGraph } from "@/state/graph"

import { Compare } from "./Compare"

const registry = liveRegistry as unknown as Registry
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

function serve() {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/registry") return ok(liveRegistry)
      return missing()
    }),
  )
}

/** The page reads the node to compare from the query string, as Build's Sweep buttons set it. */
function openAt(query: string) {
  window.history.replaceState(null, "", `/compare${query}`)
}

const picker = () => screen.getByLabelText("Compare") as HTMLSelectElement
const columns = () => (screen.getAllByLabelText("Transform") as HTMLSelectElement[]).map((s) => s.value)
const text = () => document.body.textContent ?? ""

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.stubGlobal("EventSource", SilentEventSource)
  serve()
  storeGraph(sampleGraph(registry, SOURCE))
  openAt("")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

describe("the Compare stage picker", () => {
  it("lists Parse and Chunk, starts on Chunk, and seeds a column per chunker", async () => {
    render(<Compare />)
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Compare" })).toBeTruthy())
    const options = Array.from(picker().options).map((o) => o.textContent)
    expect(options).toEqual(["Parse", "Chunk"])
    expect(picker().value).toBe("chunk")
    expect(text()).toMatch(/The Chunk step over chunking-primer\.pdf/)
    expect(columns()).toEqual(["recursive_character", "markdown_header", "token_based", "layout_blocks", "sentence_window"])
  })

  it("moves the comparison to Parse: the parsers, the sentence and the URL follow", async () => {
    render(<Compare />)
    await waitFor(() => expect(picker().value).toBe("chunk"))
    fireEvent.change(picker(), { target: { value: "parse" } })
    await waitFor(() => expect(picker().value).toBe("parse"))
    expect(columns()).toEqual(["docling", "pdfium"])
    expect(text()).toMatch(/The Parse step over chunking-primer\.pdf/)
    expect(new URLSearchParams(window.location.search).get("node")).toBe("parse")
  })

  it("has no Show through dropdown for Parse or Chunk", async () => {
    render(<Compare />)
    await waitFor(() => expect(picker().value).toBe("chunk"))
    expect(screen.queryByLabelText("Show through")).toBeNull()
    expect(screen.queryByLabelText("Show")).toBeNull()
    fireEvent.change(picker(), { target: { value: "parse" } })
    await waitFor(() => expect(picker().value).toBe("parse"))
    expect(screen.queryByLabelText("Show through")).toBeNull()
    expect(screen.queryByLabelText("Show")).toBeNull()
  })

  it("lists and selects the Index node it was opened on, and shows the Show through dropdown there", async () => {
    openAt("?node=index")
    render(<Compare />)
    await waitFor(() => expect(picker().value).toBe("index"))
    const options = Array.from(picker().options).map((o) => o.textContent)
    expect(options).toEqual(["Parse", "Chunk", "Index"])
    expect(text()).toMatch(/The Index step over chunking-primer\.pdf/)
    expect(screen.getByLabelText("Show through")).toBeTruthy()
  })

  it("has no em-dashes or en-dashes", async () => {
    render(<Compare />)
    await waitFor(() => expect(picker().value).toBe("chunk"))
    expect(text()).not.toMatch(/[–—]/)
  })
})
