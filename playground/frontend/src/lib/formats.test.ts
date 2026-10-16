import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { acceptFor, formatOf, formatsLine, hasPages, readableFormats, readsLine } from "./formats"

const registry = liveRegistry as unknown as Registry

describe("formats", () => {
  it("knows a file's format by its extension", () => {
    expect(formatOf("notes.DOCX")).toBe("docx")
    expect(formatOf("page.htm")).toBe("html")
    expect(formatOf("photo.jpeg")).toBe("jpg")
    expect(formatOf("sheet.xlsx")).toBeNull()
    expect(formatOf("README")).toBeNull()
  })

  it("lists every format a parser declares, in one order", () => {
    expect(readableFormats(registry)).toEqual(["pdf", "docx", "pptx", "html", "md", "txt", "png", "jpg"])
    expect(readableFormats({ parse: { pdfium: registry.parse!.pdfium } })).toEqual(["pdf"])
  })

  it("builds the file input's accept list and the menu's line", () => {
    expect(acceptFor(["pdf", "docx", "html"])).toBe(".pdf,.docx,.html,.htm")
    expect(formatsLine(readableFormats(registry))).toBe("PDF, Word, PowerPoint, HTML, Markdown, text or images")
    expect(formatsLine(["pdf"])).toBe("PDF")
  })

  it("says what a parser reads", () => {
    expect(readsLine("pdfium", ["pdf"])).toBe("pdfium reads PDF files only.")
    expect(readsLine("x", ["pdf", "docx"])).toBe("x reads PDF and Word files only.")
  })

  it("only a PDF, or a file with no extension, has page images", () => {
    expect(hasPages("a.pdf")).toBe(true)
    expect(hasPages("upload")).toBe(true)
    expect(hasPages("notes.docx")).toBe(false)
    expect(hasPages("slides.pptx")).toBe(false)
    expect(hasPages("scan.png")).toBe(false)
  })
})
