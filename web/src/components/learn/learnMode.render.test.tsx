import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Registry, TransformInfo } from "@/api/types"
import { resetStagesCache } from "@/api/useExplain"
import { PipelineColumn } from "@/components/pipeline/PipelineColumn"
import { SchemaForm } from "@/components/SchemaForm"
import { initialGraph } from "@/state/graph"
import { resetLearnModeForTests, setLearnMode } from "@/state/learnMode"
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
  resetLearnModeForTests()
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
  it("shows each field's hint under it, and Read more opens its paragraphs", () => {
    render(<SchemaForm schema={rc.config_schema} value={{ chunk_size: 1000, chunk_overlap: 200 }} onChange={() => {}} learn={LEARN} />)
    expect(screen.getByText(LEARN.chunk_size.hint)).toBeTruthy()
    expect(screen.getByText(LEARN.chunk_overlap.hint)).toBeTruthy()
    const more = screen.getAllByText("Read more")
    expect(more).toHaveLength(2)
    const details = more[0].closest("details")!
    expect(details.open).toBe(false)
    fireEvent.click(more[0])
    expect(details.open).toBe(true)
    expect(within(details).getByText("Four characters are roughly one token.")).toBeTruthy()
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

describe("Build with Learn mode", () => {
  it("on: the Chunk card opens with its stage lesson, the strategy hint and each setting's hint", async () => {
    column()
    const card = chunkCard()
    await waitFor(() => expect(within(card).getByText(LESSON[0])).toBeTruthy())
    const lesson = within(card).getByText("What is chunking?").closest("details")!
    expect(lesson.open).toBe(true)
    expect(within(card).getByText(LEARN._strategy.hint)).toBeTruthy()
    expect(within(card).getByText(LEARN.chunk_size.hint)).toBeTruthy()
  })

  it("off: none of it renders", async () => {
    setLearnMode(false)
    column()
    const card = chunkCard()
    // Give the stages request time to land, then check it still does not show.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(within(card).queryByText(LESSON[0])).toBeNull()
    expect(within(card).queryByText(LEARN._strategy.hint)).toBeNull()
    expect(within(card).queryByText(LEARN.chunk_size.hint)).toBeNull()
    expect(within(card).queryByText("Read more")).toBeNull()
  })

  it("turning it off hides what was shown", async () => {
    column()
    const card = chunkCard()
    await waitFor(() => expect(within(card).getByText(LESSON[0])).toBeTruthy())
    act(() => setLearnMode(false))
    expect(within(card).queryByText(LESSON[0])).toBeNull()
    expect(within(card).queryByText(LEARN.chunk_size.hint)).toBeNull()
  })
})
