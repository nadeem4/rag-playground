import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { clearPdfCaches } from "@/api/usePdf"
import { LAB, layoutRatio, PARSER_LABEL, perPage, RECAP, RULES, SITUATION, verdict } from "@/learn/parsing"
import { readProgress } from "@/state/lessons"

import { ParsingLesson } from "./ParsingLesson"

const registry = liveRegistry as unknown as Registry

beforeEach(() => {
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/learn/document"
        ? new Response(JSON.stringify({ filename: "chunking-primer.pdf", page_count: 3, text: "Some text." }))
        : new Response("{}", { status: 404 }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const rail = () => screen.getByRole("navigation", { name: "Steps" })
const steps = () => within(rail()).getAllByRole("button")
const panel = () => screen.getByRole("region", { name: "The step" })
const pick = (label: string) => fireEvent.click(within(panel()).getByRole("button", { name: label }))

describe("Choosing a parser", () => {
  it("has a step per case, the rules and a recap, and opens on the first situation with two choices", () => {
    render(<ParsingLesson registry={registry} />)
    expect(steps().map((s) => s.textContent)).toEqual(["1Two-column report", "2Table of figures", "3Scanned notes", "4When to choose which", "5Recap"])
    expect(within(panel()).getByText(SITUATION["two-column-report"])).toBeTruthy()
    expect(within(panel()).getByText("Which parser do you pick?")).toBeTruthy()
    expect(within(panel()).getByRole("button", { name: "Fast text" })).toBeTruthy()
    expect(within(panel()).getByRole("button", { name: "Layout" })).toBeTruthy()
    expect(within(panel()).queryByRole("table")).toBeNull()
  })

  it("shows the case's own document beside each case step, not the primer", () => {
    render(<ParsingLesson registry={registry} />)
    const doc = () => screen.getByRole("region", { name: "The document" })
    expect(within(doc()).getByText(/^Two-column report, 2 pages\./)).toBeTruthy()
    fireEvent.click(steps()[1])
    expect(within(doc()).getByText(/^Table of figures, 2 pages\./)).toBeTruthy()
    expect(within(doc()).queryByRole("tab", { name: "Text" })).toBeNull()
    fireEvent.click(steps()[3])
    expect(within(doc()).getByText(/^Two-column report, 2 pages\./)).toBeTruthy()
  })

  it("reveals both parsers' measurements, the excerpts and the verdict after a pick", () => {
    render(<ParsingLesson registry={registry} />)
    pick("Layout")
    const c = LAB.cases[0]
    const table = within(panel()).getByRole("table")
    expect(within(table).getByText(`Measured on ${c.pages} pages`)).toBeTruthy()
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Fast text", "Layout"])
    expect(within(rows[1]).getByText(`${c.parsers.docling.hits} of ${c.questions}`)).toBeTruthy()
    expect(within(rows[1]).getByText(String(c.parsers.docling.chars))).toBeTruthy()
    expect(within(rows[1]).getByText(String(perPage(c.parsers.docling, c.pages)))).toBeTruthy()
    expect(within(panel()).getByText(c.parsers.pdfium.excerpt!)).toBeTruthy()
    expect(within(panel()).getByText(c.parsers.docling.excerpt!)).toBeTruthy()
    expect(within(panel()).getByText(verdict(c, "docling"))).toBeTruthy()
    expect(within(panel()).getByRole("button", { name: "Layout" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("says why an excerpt is missing: scattered words, or nothing read at all", () => {
    render(<ParsingLesson registry={registry} />)
    fireEvent.click(steps()[1])
    pick("Fast text")
    expect(within(panel()).getByText("The answer's words do not appear together in this text.")).toBeTruthy()
    fireEvent.click(steps()[2])
    pick("Fast text")
    expect(within(panel()).getByText("Nothing was read.")).toBeTruthy()
    expect(within(panel()).getByText(LAB.cases[2].parsers.docling.excerpt!)).toBeTruthy()
  })

  it("keeps each case's pick when you move between steps", () => {
    render(<ParsingLesson registry={registry} />)
    pick("Fast text")
    fireEvent.click(steps()[1])
    expect(within(panel()).queryByRole("table")).toBeNull()
    fireEvent.click(steps()[0])
    expect(within(panel()).getByText(verdict(LAB.cases[0], "pdfium"))).toBeTruthy()
  })

  it("offers a Build link for each parser", () => {
    render(<ParsingLesson registry={registry} />)
    pick("Layout")
    for (const p of ["pdfium", "docling"] as const) {
      const link = within(panel()).getByRole("link", { name: `Run it with ${PARSER_LABEL[p]}` })
      expect(link.getAttribute("href")!.startsWith("/build?pipeline=")).toBe(true)
    }
  })

  it("ends with the trade-off across the cases and three rules carrying the recorded numbers", () => {
    render(<ParsingLesson registry={registry} />)
    fireEvent.click(steps()[3])
    const rows = within(within(panel()).getByRole("table")).getAllByRole("row").slice(1)
    expect(rows).toHaveLength(LAB.cases.length * 2)
    for (const r of RULES) expect(within(panel()).getByText(r)).toBeTruthy()
    const digital = LAB.cases.filter((c) => c.name !== "scanned-notes")
    const scan = LAB.cases[2]
    expect(within(panel()).getByText(new RegExp(`It costs ${layoutRatio(digital)} times more per page here`))).toBeTruthy()
    expect(within(panel()).getByText(new RegExp(`OCR cost ${perPage(scan.parsers.docling, scan.pages)} seconds per page`))).toBeTruthy()
    expect(within(panel()).getByText("These numbers were measured on one machine. Yours will differ. The ratios are what to carry with you.")).toBeTruthy()
  })

  it("recaps, then Mark as done", () => {
    render(<ParsingLesson registry={registry} />)
    fireEvent.click(steps()[4])
    for (const line of RECAP) expect(within(panel()).getByText(line)).toBeTruthy()
    fireEvent.click(within(panel()).getByRole("link", { name: "Mark as done" }))
    expect(readProgress()).toMatchObject({ parsing: true })
  })

  it("uses no em-dashes or en-dashes on any step, before or after a pick", () => {
    render(<ParsingLesson registry={registry} />)
    for (let i = 0; i < 5; i++) {
      fireEvent.click(steps()[i])
      if (i < 3) pick("Layout")
      expect(document.body.textContent ?? "").not.toMatch(/[—–]/)
    }
  })
})
