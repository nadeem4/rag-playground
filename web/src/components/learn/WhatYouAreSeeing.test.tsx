import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import chunkSet from "@/api/fixtures/chunk_set.recursive_character.json"
import type { ChunkSet } from "@/api/types"
import { analyzeChunks, seeingLines } from "@/learn/chunks"
import { resetLearnModeForTests, setLearnMode } from "@/state/learnMode"

import { WhatYouAreSeeing } from "./WhatYouAreSeeing"

const SET = chunkSet as unknown as ChunkSet

beforeEach(() => {
  window.localStorage.clear()
  resetLearnModeForTests()
})
afterEach(cleanup)

describe("What you are seeing (Build, Chunk output)", () => {
  it("is computed from the real chunk set, and links to the chunking lesson", () => {
    render(<WhatYouAreSeeing data={SET} />)
    const box = screen.getByRole("region", { name: "What you are seeing" })
    for (const line of seeingLines(analyzeChunks(SET))) expect(box.textContent).toContain(line)
    expect(box.textContent).toContain(`The document became ${SET.chunks.length} chunks.`)
    const link = screen.getByRole("link", { name: "Practice in the chunking lesson" })
    expect(link.getAttribute("href")).toBe("/learn/chunking")
  })

  it("renders nothing with Learn mode off, or without a chunk set", () => {
    setLearnMode(false)
    const { container, rerender } = render(<WhatYouAreSeeing data={SET} />)
    expect(container.textContent).toBe("")
    act(() => setLearnMode(true))
    rerender(<WhatYouAreSeeing data={{ nope: 1 }} />)
    expect(container.textContent).toBe("")
  })
})
