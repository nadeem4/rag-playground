import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import chunkSet from "@/api/fixtures/chunk_set.recursive_character.json"
import type { ChunkSet } from "@/api/types"
import { analyzeChunks, seeingLines } from "@/learn/chunks"

import { WhatYouAreSeeing } from "./WhatYouAreSeeing"

const SET = chunkSet as unknown as ChunkSet

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(cleanup)

describe("What you are seeing (Build, Chunk output)", () => {
  it("is computed from the real chunk set, and links to the chunking lesson", () => {
    render(<WhatYouAreSeeing data={SET} lessonsEnabled />)
    const box = screen.getByRole("region", { name: "What you are seeing" })
    for (const line of seeingLines(analyzeChunks(SET))) expect(box.textContent).toContain(line)
    expect(box.textContent).toContain(`The document became ${SET.chunks.length} chunks.`)
    const link = screen.getByRole("link", { name: "Practice in the chunking lesson" })
    expect(link.getAttribute("href")).toBe("/learn/chunking")
  })

  it("has no lesson link while the lessons are hidden", () => {
    render(<WhatYouAreSeeing data={SET} lessonsEnabled={false} />)
    expect(screen.getByRole("region", { name: "What you are seeing" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Practice in the chunking lesson" })).toBeNull()
  })

  it("renders nothing without a chunk set", () => {
    const { container } = render(<WhatYouAreSeeing data={{ nope: 1 }} />)
    expect(container.textContent).toBe("")
  })
})
