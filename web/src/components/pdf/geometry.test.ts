import { describe, expect, it } from "vitest"

import parsedJson from "@/api/fixtures/parsed_doc.json"
import type { Element, ParsedDoc } from "@/api/types"

import { citationHighlight, highlightWords, pdfRectToCss, regionsForElements } from "./geometry"

const LETTER = { width: 612, height: 792 }
const parsed = parsedJson as unknown as ParsedDoc

describe("pdfRectToCss", () => {
  it("flips y: a rect's CSS top is the page height minus its PDF top", () => {
    expect(pdfRectToCss([72, 700, 272, 720], LETTER, 1)).toEqual({ left: 72, top: 72, width: 200, height: 20 })
  })

  it("puts the page's bottom edge at the bottom, and its top at 0", () => {
    expect(pdfRectToCss([0, 0, 10, 10], LETTER, 1).top).toBe(782)
    expect(pdfRectToCss([0, 782, 10, 792], LETTER, 1).top).toBe(0)
  })

  it("scales every edge by CSS px per point", () => {
    expect(pdfRectToCss([72, 700, 272, 720], LETTER, 2)).toEqual({ left: 144, top: 144, width: 400, height: 40 })
    expect(pdfRectToCss([72, 700, 272, 720], LETTER, 1.25)).toEqual({ left: 90, top: 90, width: 250, height: 25 })
  })

  it("normalises corners given in either order and clips to the page", () => {
    expect(pdfRectToCss([272, 720, 72, 700], LETTER, 1)).toEqual({ left: 72, top: 72, width: 200, height: 20 })
    expect(pdfRectToCss([-10, -5, 700, 900], LETTER, 1)).toEqual({ left: 0, top: 0, width: 612, height: 792 })
  })

  it("places a real element bbox from the fixture", () => {
    const e = parsed.elements.find((x) => x.id === "e00002")!
    const box = pdfRectToCss(e.bbox!, LETTER, 1)
    expect(box.left).toBe(72)
    expect(box.top).toBeCloseTo(792 - 674.86, 1)
    expect(box.height).toBeCloseTo(674.86 - 597.468, 2)
  })
})

describe("regionsForElements", () => {
  it("picks exactly the listed elements with their page and bbox", () => {
    const r = regionsForElements(parsed.elements, ["e00001", "e00002"])
    expect(r.regions.map((x) => x.page)).toEqual([1, 1])
    expect(r.regions.map((x) => x.rect)).toEqual(["e00001", "e00002"].map((id) => parsed.elements.find((e) => e.id === id)!.bbox))
    expect(r.pages).toEqual([1])
    expect(r.noBbox).toBe(false)
  })

  it("spans pages when the elements do", () => {
    expect(regionsForElements(parsed.elements, ["e00010", "e00011", "e00014"]).pages).toEqual([2, 3])
  })

  it("reports a parser that gives no bbox, keeping the pages", () => {
    const flat: Element[] = parsed.elements.map((e) => ({ ...e, bbox: null }))
    const r = regionsForElements(flat, ["e00001", "e00002"])
    expect(r.regions).toEqual([])
    expect(r.noBbox).toBe(true)
    expect(r.pages).toEqual([1])
  })

  it("ignores ids that are not in the document", () => {
    const r = regionsForElements(parsed.elements, ["nope"])
    expect(r).toEqual({ regions: [], pages: [], found: 0, noBbox: false })
  })
})

describe("citationHighlight", () => {
  const bbox: [number, number, number, number] = [72, 597, 486, 675]

  it("prefers the rects the page search found", () => {
    const h = citationHighlight({ rects: [[72, 660, 480, 672], [72, 646, 300, 658]], matched: "exact" }, { bbox })
    expect(h).toEqual({ how: "text", matched: "exact", rects: [[72, 660, 480, 672], [72, 646, 300, 658]] })
    expect(highlightWords(h)).toMatch(/found on the page as quoted/)
    expect(highlightWords({ how: "text", matched: "normalized", rects: [] })).toMatch(/collapsing whitespace/)
  })

  it("falls back to the element's bbox when the text was not found", () => {
    const h = citationHighlight({ rects: [], matched: "none" }, { bbox })
    expect(h).toEqual({ how: "element", rects: [bbox] })
    expect(highlightWords(h)).toMatch(/not found on the page\. Showing the whole element/)
  })

  it("falls back the same way when the search failed", () => {
    expect(citationHighlight(null, { bbox }).how).toBe("element")
  })

  it("highlights nothing, and says so, when there is no bbox either", () => {
    const h = citationHighlight({ rects: [], matched: "none" }, { bbox: null })
    expect(h).toEqual({ how: "none", rects: [] })
    expect(highlightWords(h)).toMatch(/nothing is highlighted/)
  })
})
