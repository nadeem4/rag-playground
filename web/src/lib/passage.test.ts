import { describe, expect, it } from "vitest"

import { flatRow, isTableRow, passageBlocks, plainPassage } from "./passage"

const TABLE = [
  "Results of the study.",
  "| Measure | Before | After | Change |",
  "|----------------------------|----------|---------|----------|",
  "| Reading time per page | 84 s | 61 s | -27% |",
  "| Readers who lost their place | 41 | 16 | -61% |",
  "The layout was the only change.",
].join("\n")

describe("passageBlocks", () => {
  it("splits a piece into its text and its table, with the header and the rows as cells", () => {
    expect(passageBlocks(TABLE)).toEqual([
      { kind: "text", text: "Results of the study." },
      {
        kind: "table",
        head: ["Measure", "Before", "After", "Change"],
        rows: [
          ["Reading time per page", "84 s", "61 s", "-27%"],
          ["Readers who lost their place", "41", "16", "-61%"],
        ],
      },
      { kind: "text", text: "The layout was the only change." },
    ])
  })

  it("reads a table cut off above its header, as a chunk boundary leaves it, as rows with no head", () => {
    const cut = "| Reading time per page | 84 s | 61 s | -27% |\n| Readers who lost their place | 41 | 16 | -61% |"
    expect(passageBlocks(cut)).toEqual([
      {
        kind: "table",
        head: [],
        rows: [
          ["Reading time per page", "84 s", "61 s", "-27%"],
          ["Readers who lost their place", "41", "16", "-61%"],
        ],
      },
    ])
  })

  it("leaves text alone: a bar inside a sentence is not a table", () => {
    expect(passageBlocks("Use a | b here.\nAnd more.")).toEqual([{ kind: "text", text: "Use a | b here.\nAnd more." }])
  })

  it("says a lone row in words, even one cut off before its last bar, and drops a lone rule", () => {
    // A chunk boundary can leave just the header row at a piece's end, or part of it.
    const tail = "Table 1. Results of the study\n| Measure | Before | After | Change "
    expect(passageBlocks(tail)).toEqual([{ kind: "text", text: "Table 1. Results of the study\nMeasure: Before, After, Change" }])
    expect(passageBlocks("Intro.\n| Measure | Before |\n|---|---|")).toEqual([
      { kind: "text", text: "Intro." },
      { kind: "table", head: ["Measure", "Before"], rows: [] },
    ])
    expect(passageBlocks("Intro.\n|---|---|")).toEqual([{ kind: "text", text: "Intro." }])
  })

  it("takes the heading marks off a heading inside the piece", () => {
    expect(passageBlocks("Every measure below.\n## Results\nTable 1.")).toEqual([{ kind: "text", text: "Every measure below.\nResults\nTable 1." }])
  })
})

describe("plain words for a clamped piece and a quote", () => {
  it("a row reads as its label, then its values", () => {
    expect(flatRow("| Readers who lost their place | 41 | 16 | -61% |")).toBe("Readers who lost their place: 41, 16, -61%")
    expect(isTableRow("| a | b |")).toBe(true)
    expect(isTableRow("a | b")).toBe(false)
  })

  it("a clamped piece has no bars and no rule of dashes", () => {
    const plain = plainPassage(TABLE)
    expect(plain).not.toMatch(/\||---/)
    expect(plain).toBe(
      "Results of the study.\nMeasure: Before, After, Change; Reading time per page: 84 s, 61 s, -27%; Readers who lost their place: 41, 16, -61%\nThe layout was the only change.",
    )
  })
})
