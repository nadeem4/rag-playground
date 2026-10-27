import { describe, expect, it } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import index from "@/api/fixtures/index.lancedb.json"
import parsedDoc from "@/api/fixtures/parsed_doc.json"
import { outcomeFor, outcomeText } from "@/components/pipeline/outcome"

import { askResultLine, fixResultLine, stepResultLine } from "./guideResult"

const doc = { filename: "report.pdf", pages: 3 }
const cardText = (...a: Parameters<typeof outcomeFor>) => outcomeText(outcomeFor(...a)!)

describe("stepResultLine", () => {
  it("source shows the title and the page count", () => {
    expect(stepResultLine("source", undefined, null, doc)).toBe("report.pdf · 3 pages")
    expect(stepResultLine("source", undefined, null, { filename: "a.pdf", pages: 12 })).toBe("a.pdf · 12 pages")
    expect(stepResultLine("source", undefined, null, { filename: "a.pdf", pages: 1 })).toBe("a.pdf · 1 page")
    expect(stepResultLine("source", undefined, null, { filename: "a.pdf" })).toBe("a.pdf")
  })

  it("other stages use the same text the card shows", () => {
    expect(stepResultLine("parse", "parsed_doc", parsedDoc, doc)).toBe(cardText("parse", "parsed_doc", parsedDoc))
    expect(stepResultLine("chunk", "chunk_set", chunkRecursive, doc)).toBe(cardText("chunk", "chunk_set", chunkRecursive))
    expect(stepResultLine("index", "index", index, doc)).toBe(cardText("index", "index", index))
  })

  it("is null when the card has no outcome", () => {
    expect(stepResultLine("chunk", "chunk_set", null, doc)).toBeNull()
  })
})

describe("askResultLine", () => {
  it("found within the pieces that are read", () => {
    const s = askResultLine({ found: { rank: 2 }, shown: 5, candidates: 20 })
    expect(s).toContain("2nd")
    expect(s).toContain("5")
    expect(s).toMatch(/read/)
    expect(askResultLine({ found: { rank: 3 }, shown: 7, candidates: 20 })).toContain("7")
  })

  it("found below the pieces that are read", () => {
    const s = askResultLine({ found: { rank: 11 }, shown: 5, candidates: 20 })
    expect(s).toContain("11th")
    expect(s).toContain("5")
    expect(s).toMatch(/below/)
    expect(askResultLine({ found: { rank: 22 }, shown: 3, candidates: 30 })).toContain("22nd")
  })

  it("not found names the candidates", () => {
    const s = askResultLine({ found: null, shown: 5, candidates: 20 })
    expect(s).toContain("20")
    expect(s).toMatch(/no/i)
    expect(askResultLine({ found: null, shown: 5, candidates: 33 })).toContain("33")
  })
})

describe("fixResultLine", () => {
  it("mentions both ranks", () => {
    const s = fixResultLine({ before: { rank: 11 }, after: { rank: 1 }, chunk: null })
    expect(s).toContain("11th")
    expect(s).toContain("1st")
    expect(fixResultLine({ before: { rank: 8 }, after: { rank: 3 }, chunk: null })).toContain("8th")
  })

  it("was not found before, found now", () => {
    const s = fixResultLine({ before: null, after: { rank: 4 }, chunk: null })
    expect(s).toContain("4th")
  })

  it("still not found invents no rank", () => {
    const s = fixResultLine({ before: { rank: 11 }, after: null, chunk: null })
    expect(s).toMatch(/not/i)
    expect(s).not.toMatch(/\d+(st|nd|rd|th)\b.*\d+(st|nd|rd|th)\b/)
    expect(fixResultLine({ before: null, after: null, chunk: null })).toMatch(/not/i)
  })

  it("names the chunk when given", () => {
    expect(fixResultLine({ before: { rank: 11 }, after: { rank: 1 }, chunk: "chunk-7" })).toContain("chunk-7")
  })
})
