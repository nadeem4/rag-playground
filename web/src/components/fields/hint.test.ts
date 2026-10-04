import { describe, expect, it } from "vitest"

import { hintFor } from "./hint"

describe("hintFor", () => {
  it("keeps a short first sentence that names a unit", () => {
    expect(hintFor("The largest a chunk can be, counted in characters. Small chunks match precisely.")).toBe(
      "The largest a chunk can be, counted in characters.",
    )
    expect(hintFor("How many tokens each chunk repeats.")).toBe("How many tokens each chunk repeats.")
    expect(hintFor("Wait time in seconds. Longer waits are safer.")).toBe("Wait time in seconds.")
    expect(hintFor("Image width in px. Wider is slower.")).toBe("Image width in px.")
    expect(hintFor("Page height in pixels.")).toBe("Page height in pixels.")
    expect(hintFor("Chunks per page. More is finer.")).toBe("Chunks per page.")
  })

  it("keeps a short first sentence that names a range", () => {
    expect(hintFor("A score from 0 to 1. Higher keeps fewer.")).toBe("A score from 0 to 1.")
  })

  it("gives no hint for a first sentence longer than 60 characters, even with a unit", () => {
    expect(hintFor("The largest number of characters a chunk can hold before it is cut in two. More.")).toBeNull()
  })

  it("gives no hint when the first sentence names no unit or range", () => {
    expect(hintFor("Docling's PdfPipelineOptions.do_ocr. Read text from page images with OCR.")).toBeNull()
    expect(hintFor("Which model to use.")).toBeNull()
  })

  it("matches whole words only, so upper or perform are not units", () => {
    expect(hintFor("Use the upper bound.")).toBeNull()
    expect(hintFor("Perform it twice.")).toBeNull()
  })

  it("gives no hint for no description", () => {
    expect(hintFor(undefined)).toBeNull()
    expect(hintFor("")).toBeNull()
  })
})
