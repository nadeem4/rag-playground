import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Popover } from "radix-ui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import { resetStagesCache } from "@/api/useExplain"
import type { ExplainState } from "@/api/useExplain"
import { initialGraph } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { ExplainPanel } from "./ExplainPanel"
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

  it("ends with the stage's deep-dive posts as external links, in list order", async () => {
    setup()
    fireEvent.click(info("Chunk"))
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    const section = within(dialog).getByRole("region", { name: "Read the deep dive" })
    const links = within(section).getAllByRole("link")
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://medium.com/learnwithnk/chunking-fundamentals-what-chunk-size-actually-trades-off-216675ec62be",
      "https://medium.com/learnwithnk/advanced-chunking-parent-child-contextual-retrieval-late-chunking-and-hierarchical-summaries-e6ea55662d07",
      "https://medium.com/learnwithnk/metadata-and-enrichment-what-to-store-beside-each-chunk-fa19a3b63304",
    ])
    expect(links[0].textContent).toBe("Chunking Fundamentals: What Chunk Size Actually Trades Off")
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank")
      expect(a.getAttribute("rel")).toBe("noreferrer")
    }
  })

  it("has no deep-dive section for a stage with no posts", async () => {
    // No column card lacks posts now, so the panel is rendered on its own, for a rerank node.
    render(
      <Popover.Root open>
        <Popover.Anchor />
        <ExplainPanel title="Rerank" stage="rerank" transform="mmr" summary="Summary of mmr." explain={explained("s")} anchor={() => null} />
      </Popover.Root>,
    )
    const dialog = await screen.findByRole("dialog", { name: "About the Rerank step" })
    expect(within(dialog).getByText("Summary of mmr.")).toBeTruthy()
    expect(within(dialog).queryByText("Read the deep dive")).toBeNull()
    expect(within(dialog).queryByRole("link")).toBeNull()
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

  it("a missing file asks calmly for a sample, not for an Upload settings fix", () => {
    setup({ explanations: { source: explained("x", { warning: "Choose a file.", blocking: true }) } })
    const note = within(card("chunk")).getByTestId("run-note")
    expect(note.textContent).toBe("Load a sample to start.")
    expect(note.className).toContain("text-fg-muted")
    expect(note.className).not.toContain("text-danger")
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

  it("sets the sentence in the reading face, with only its numbers in mono", async () => {
    payloads = { f1: chunkRecursive }
    setup({ results: done("f1") })
    const block = await within(card("chunk")).findByTestId("what-it-did")
    const sentence = await waitFor(() => {
      const p = block.querySelector("p")
      if (!p) throw new Error("no sentence yet")
      return p
    })
    expect(sentence.className).not.toContain("font-mono")
    expect(sentence.className).toContain("text-base")
    expect(within(sentence).getByText("6").className).toContain("font-mono")
    expect(within(sentence).getByText("67").className).toContain("font-mono")
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
    const sentence = block.querySelector("p")!
    expect(sentence.textContent).toMatch(/^Made 6 chunks/)
    expect(sentence.className).toContain("text-fg-muted")
    expect(within(card("chunk")).getByTestId("run-note").textContent).toBe("Settings changed since the last run.")
    expect(within(card("chunk")).queryByText("A note about the old run.")).toBeNull()
  })

  it("cards stay compact: no summary line before a run", () => {
    setup()
    expect(within(card("chunk")).queryByTestId("what-it-did")).toBeNull()
    expect(within(card("chunk")).queryByText("Each piece holds up to 1,000 characters.")).toBeNull()
  })
})

describe("the explanation pop-over's size and side", () => {
  const panel = () =>
    render(
      <Popover.Root open>
        <Popover.Anchor />
        <ExplainPanel title="Chunk" stage="chunk" transform="recursive_character" explain={explained("s")} anchor={() => null} />
      </Popover.Root>,
    )
  const wide = (matches: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
    )

  it("is never taller than the room it has, and scrolls inside", async () => {
    panel()
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    expect(dialog.className).toContain("max-h-(--radix-popover-content-available-height)")
    expect(dialog.className).toContain("overflow-y-auto")
    expect(dialog.className).toContain("max-w-[calc(100vw-32px)]")
  })

  it("opens below the card on a narrow screen", async () => {
    wide(false)
    panel()
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    await waitFor(() => expect(dialog.getAttribute("data-side")).toBe("bottom"))
  })

  it("opens beside the card on a wide screen", async () => {
    wide(true)
    panel()
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    await waitFor(() => expect(dialog.getAttribute("data-side")).toBe("right"))
  })
})
