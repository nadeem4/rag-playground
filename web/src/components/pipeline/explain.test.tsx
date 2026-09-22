import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import { resetStagesCache } from "@/api/useExplain"
import type { ExplainState } from "@/api/useExplain"
import { initialGraph } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { PipelineColumn, type PipelineColumnProps } from "./PipelineColumn"

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const STAGES = {
  parse: { what: "Parsing turns the PDF into a structured document." },
  chunk: { what: "Chunking decides where the pieces start and end." },
}

/** Payloads and meta by artifact id. */
let payloads: Record<string, unknown> = {}
let metas: Record<string, Record<string, unknown>> = {}

beforeEach(() => {
  payloads = {}
  metas = {}
  resetStagesCache()
  vi.stubGlobal("ResizeObserver", NoopResizeObserver)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/stages") return ok(STAGES)
      const payload = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (payload) return ok(payloads[payload[1]])
      const meta = /^\/api\/artifacts\/([^/]+)$/.exec(url)
      if (meta) return ok({ id: meta[1], type: "chunk_set", meta: metas[meta[1]] ?? {} })
      return ok([])
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const explained = (settings: string, extra: Partial<NonNullable<ExplainState["data"]>> = {}): ExplainState => ({
  data: { settings, tradeoff: null, warning: null, blocking: false, ...extra },
})

function setup(over: Partial<PipelineColumnProps> = {}) {
  const props: PipelineColumnProps = {
    graph: initialGraph(R),
    registry: R,
    results: {},
    stale: new Set(),
    selected: null,
    busy: false,
    errors: {},
    onSelect: vi.fn(),
    onTransform: vi.fn(),
    onConfig: vi.fn(),
    onRun: vi.fn(),
    onAddCleaner: vi.fn(),
    onRemove: vi.fn(),
    onSweep: vi.fn(),
    explanations: {
      parse: explained("Mode is text."),
      chunk: explained("Each piece holds up to 1,000 characters.", { tradeoff: "a middle size." }),
    },
    ...over,
  }
  const view = render(<PipelineColumn {...props} />)
  return { props, view }
}

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement
const info = (title: string) => screen.getByRole("button", { name: `Explain the ${title} step` })

describe("the explanation pop-over", () => {
  it("opens beside the card with all four parts", async () => {
    setup()
    const button = info("Chunk")
    expect(button.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(button)
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    expect(button.getAttribute("aria-expanded")).toBe("true")
    await waitFor(() => expect(within(dialog).getByText(STAGES.chunk.what)).toBeTruthy())
    expect(within(dialog).getByRole("heading", { name: "What this step does" })).toBeTruthy()
    expect(within(dialog).getByRole("heading", { name: "How recursive_character works" })).toBeTruthy()
    expect(within(dialog).getByText("Summary of recursive_character.")).toBeTruthy()
    expect(within(dialog).getByRole("heading", { name: "With your settings" })).toBeTruthy()
    expect(within(dialog).getByText("Each piece holds up to 1,000 characters.")).toBeTruthy()
    expect(within(dialog).getByText("Trade-off: a middle size.")).toBeTruthy()
    // Focus moves into the pop-over.
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it("has no trade-off line when there is none", async () => {
    setup()
    fireEvent.click(info("Parse"))
    const dialog = await screen.findByRole("dialog", { name: "About the Parse step" })
    expect(within(dialog).queryByText(/^Trade-off/)).toBeNull()
  })

  it("only one is open at a time", async () => {
    setup()
    fireEvent.click(info("Parse"))
    await screen.findByRole("dialog", { name: "About the Parse step" })
    fireEvent.click(info("Chunk"))
    await screen.findByRole("dialog", { name: "About the Chunk step" })
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(info("Parse").getAttribute("aria-expanded")).toBe("false")
  })

  it("Escape closes it and returns focus to the info button", async () => {
    setup()
    fireEvent.click(info("Chunk"))
    const dialog = await screen.findByRole("dialog")
    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(info("Chunk"))
  })

  it("Close closes it", async () => {
    setup()
    fireEvent.click(info("Chunk"))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("follows the explanation as it updates, and shows a 422's message", async () => {
    const { props, view } = setup()
    fireEvent.click(info("Chunk"))
    const dialog = await screen.findByRole("dialog")
    view.rerender(<PipelineColumn {...props} explanations={{ chunk: explained("Each piece holds up to 400 characters.") }} />)
    expect(within(dialog).getByText("Each piece holds up to 400 characters.")).toBeTruthy()
    view.rerender(<PipelineColumn {...props} explanations={{ chunk: { invalid: "chunk_size: Input should be greater than or equal to 1" } }} />)
    expect(within(dialog).getByText(/Input should be greater than or equal to 1/)).toBeTruthy()
  })
})

describe("the inline warning", () => {
  it("shows in the card, and a blocking one disables Run with a reason", () => {
    const warning = "Overlap must be smaller than the chunk size."
    setup({ explanations: { chunk: explained("x", { warning, blocking: true }) } })
    const c = card("chunk")
    expect(within(c).getByTestId("explain-warning").textContent).toBe(warning)
    expect((within(c).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(c).getByTestId("run-note").textContent).toBe("Fix the settings to run.")
    // Downstream cards cannot run either: the Chunk step would fail.
    expect((within(card("index")).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(card("index")).getByTestId("run-note").textContent).toBe("Fix the Chunk settings to run.")
    // Upstream is unaffected.
    expect((within(card("parse")).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("a warning that does not block leaves Run enabled", () => {
    setup({ explanations: { chunk: explained("x", { warning: "Very small pieces." }) } })
    expect(within(card("chunk")).getByTestId("explain-warning")).toBeTruthy()
    expect((within(card("chunk")).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("what it did", () => {
  const smaller = { ...chunkRecursive, chunks: chunkRecursive.chunks.slice(0, 4) }
  const done = (artifact_id: string) => ({ chunk: { id: "chunk", status: "done" as const, artifact_id, duration_ms: 3 } })

  it("the first run has no (was N); the second does", async () => {
    payloads = { c1: smaller, c2: chunkRecursive }
    const { props, view } = setup({ results: done("c1"), history: { chunk: { current: "c1" } } })
    const block = await within(card("chunk")).findByTestId("what-it-did")
    await waitFor(() => expect(block.textContent).toContain("Made 4 chunks."))
    expect(block.textContent).not.toContain("was")
    view.rerender(<PipelineColumn {...props} results={done("c2")} history={{ chunk: { current: "c2", previous: "c1" } }} />)
    await waitFor(() => expect(within(card("chunk")).getByTestId("what-it-did").textContent).toContain("Made 6 chunks (was 4)."))
  })

  it("shows the plugin's note", async () => {
    // Artifact ids are unique per test: payloads and meta are cached for the session.
    payloads = { n1: chunkRecursive }
    metas = { n1: { note: "The parser found no headings, so it fell back to token pieces." } }
    setup({ results: done("n1") })
    await waitFor(() => expect(within(card("chunk")).getByText("The parser found no headings, so it fell back to token pieces.")).toBeTruthy())
  })

  it("when the settings changed since the run, the outcome is muted and says so", async () => {
    payloads = { s1: chunkRecursive }
    metas = { s1: { note: "A note about the old run." } }
    setup({ results: done("s1"), stale: new Set(["chunk"]) })
    const block = await within(card("chunk")).findByTestId("what-it-did")
    expect(block.hasAttribute("data-stale")).toBe(true)
    expect(within(block).getByText(/^Made 6 chunks/).className).toContain("text-fg-muted")
    expect(within(card("chunk")).getByTestId("run-note").textContent).toBe("Settings changed since the last run.")
    expect(within(card("chunk")).queryByText("A note about the old run.")).toBeNull()
  })

  it("cards stay compact: no summary line before a run", () => {
    setup()
    expect(within(card("chunk")).queryByTestId("what-it-did")).toBeNull()
    expect(within(card("chunk")).queryByText("Each piece holds up to 1,000 characters.")).toBeNull()
  })
})
