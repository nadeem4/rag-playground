import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Registry, TransformInfo } from "@/api/types"
import { resetStagesCache } from "@/api/useExplain"
import { PipelineColumn } from "@/components/pipeline/PipelineColumn"
import { SchemaForm } from "@/components/SchemaForm"
import { initialGraph } from "@/state/graph"
import { TEST_REGISTRY } from "@/state/testRegistry"

/** The test registry, with I-22 lessons on recursive_character. */
const LEARN = {
  _strategy: { hint: "Cuts at the most natural place it can find.", more: ["It first tries to cut between paragraphs."] },
  chunk_size: { hint: "The largest a chunk can be, counted in characters.", more: ["A character is one letter.", "Four characters are roughly one token."] },
  chunk_overlap: { hint: "How much text each chunk repeats.", more: ["It helps at the border."] },
}
const rc = TEST_REGISTRY.chunk!.recursive_character
const R: Registry = { ...TEST_REGISTRY, chunk: { ...TEST_REGISTRY.chunk, recursive_character: { ...rc, learn: LEARN } as TransformInfo } }

const LESSON = ["Before a search can find anything, the document has to be cut into smaller pieces.", "The way you cut decides what the search can find."]

beforeEach(() => {
  window.localStorage.clear()
  resetStagesCache()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/stages") return new Response(JSON.stringify({ chunk: { what: "Cuts the document.", lesson: LESSON } }))
      return new Response("[]")
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SchemaForm with lessons", () => {
  it("puts each field's lesson behind its info button, not under the control", async () => {
    render(<SchemaForm schema={rc.config_schema} value={{ chunk_size: 1000, chunk_overlap: 200 }} onChange={() => {}} learn={LEARN} />)
    expect(screen.queryByText(LEARN.chunk_overlap.hint)).toBeNull()
    expect(screen.queryByText("Read more")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "About Chunk Overlap" }))
    const dialog = await screen.findByRole("dialog", { name: "Chunk Overlap" })
    expect(within(dialog).getByText(LEARN.chunk_overlap.hint)).toBeTruthy()
    expect(within(dialog).getByText("It helps at the border.")).toBeTruthy()
  })

  it("shows nothing extra without lessons", () => {
    render(<SchemaForm schema={rc.config_schema} value={{ chunk_size: 1000, chunk_overlap: 200 }} onChange={() => {}} />)
    expect(screen.queryByText("Read more")).toBeNull()
  })
})

function column() {
  const graph = initialGraph(R)
  render(
    <PipelineColumn
      graph={graph}
      registry={R}
      results={{}}
      stale={new Set()}
      selected={null}
      busy={false}
      errors={{}}
      onSelect={() => {}}
      onTransform={() => {}}
      onConfig={() => {}}
      onRun={() => {}}
      onAddCleaner={() => {}}
      onRemove={() => {}}
      onSweep={() => {}}
    />,
  )
}
const chunkCard = () => document.querySelector('[data-node-id="chunk"]') as HTMLElement

describe("Build lessons", () => {
  it("the Chunk card body is only fields: no stage lesson and no strategy hint inline", async () => {
    column()
    const card = chunkCard()
    fireEvent.click(within(card).getByRole("button", { name: "Explain the Chunk step" }))
    await screen.findByRole("dialog", { name: "About the Chunk step" })
    expect(within(card).queryByText(LESSON[0])).toBeNull()
    expect(within(card).queryByText("What is chunking?")).toBeNull()
    expect(within(card).queryByText(LEARN._strategy.hint)).toBeNull()
    expect(within(card).queryByText("Read more")).toBeNull()
    expect(card.querySelector("[data-learn]")).toBeNull()
  })

  it("the stage lesson is the last part of the Chunk card's explain pop-over", async () => {
    column()
    fireEvent.click(within(chunkCard()).getByRole("button", { name: "Explain the Chunk step" }))
    const dialog = await screen.findByRole("dialog", { name: "About the Chunk step" })
    await waitFor(() => expect(within(dialog).getByText(LESSON[0])).toBeTruthy())
    const parts = within(dialog).getAllByRole("region")
    expect(parts.at(-1)!.getAttribute("aria-label")).toBe("What is chunking?")
    expect(within(parts.at(-1)!).getByText(LESSON[1])).toBeTruthy()
  })

  it("the strategy lesson opens behind the Transform field's info button", async () => {
    column()
    fireEvent.click(within(chunkCard()).getByRole("button", { name: "About Transform" }))
    const dialog = await screen.findByRole("dialog", { name: "Transform" })
    expect(within(dialog).getByText(LEARN._strategy.hint)).toBeTruthy()
    expect(within(dialog).getByText("It first tries to cut between paragraphs.")).toBeTruthy()
  })
})
