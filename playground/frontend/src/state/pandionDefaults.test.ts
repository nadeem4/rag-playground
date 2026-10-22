import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { evaluateTopK, settingDefault, sizeFields, supportThreshold } from "./pandionDefaults"

const R = liveRegistry as unknown as Registry

describe("Pandion's defaults, read from its catalog", () => {
  it("reads evaluate's top k and the chat step's pass line", () => {
    expect(evaluateTopK(R)).toBe(5)
    expect(supportThreshold(R)).toBe(0.55)
    expect(evaluateTopK({})).toBeNull()
    expect(settingDefault(R, "chunk", "nope", "chunk_size")).toBeUndefined()
  })

  it.each([
    ["recursive_character", { size: "chunk_size", overlap: "chunk_overlap" }],
    ["token_based", { size: "max_tokens", overlap: "overlap" }],
    ["sentence_window", { size: "sentences_per_chunk", overlap: "overlap_sentences" }],
    ["layout_blocks", { size: "max_tokens", overlap: undefined }],
    ["markdown_header", { size: "max_tokens", overlap: undefined }],
  ])("finds %s's size and overlap by the role its schema marks", (chunker, fields) => {
    expect(sizeFields(R.chunk?.[chunker])).toEqual(fields)
  })

  it("finds nothing for a chunker the catalog does not mark", () => {
    expect(sizeFields(undefined)).toEqual({ size: undefined, overlap: undefined })
  })
})
