import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { decodePipeline } from "@/state/pipelines"

import recorded from "./parsing-lab.json"
import {
  INTRO,
  LAB,
  missingExcerpt,
  type LabCase,
  PARSER_LABEL,
  perPage,
  RECAP,
  ratio,
  RULES,
  rules,
  runLink,
  secondsPerPage,
  SITUATION,
  situation,
  verdict,
} from "./parsing"

const registry = liveRegistry as unknown as Registry
const byName = (name: string) => LAB.cases.find((c) => c.name === name)!

/** A case with made-up numbers, so the words can be checked exactly. */
function made(pdfium: { ms: number; hits: number }, docling: { ms: number; hits: number }, name = LAB.cases[0].name): LabCase {
  const run = (r: { ms: number; hits: number }) => ({ ...r, chars: 100, ocr: false, excerpt: null })
  return { ...LAB.cases[0], name, questions: 5, pages: 2, parsers: { pdfium: run(pdfium), docling: run(docling) } }
}

describe("the recording", () => {
  it("is the committed JSON, three cases in order, each with a situation, and the primer as a baseline", () => {
    expect(LAB).toEqual(recorded)
    expect(LAB.cases.map((c) => c.name)).toEqual(["two-column-report", "table-of-figures", "scanned-notes"])
    expect(LAB.baseline.name).toBe("chunking-primer")
    for (const c of LAB.cases) expect(SITUATION[c.name]).toBeTruthy()
    expect(PARSER_LABEL).toEqual({ pdfium: "Fast text", docling: "Layout" })
  })

  it("introduces the two parsers in one paragraph", () => {
    expect(INTRO).toBe(
      "Fast text (pdfium) copies the PDF's text layer in reading order. Layout (Docling) looks at the page to find columns and tables, and can run OCR.",
    )
  })
})

describe("verdict", () => {
  it("names the pick, both scores and the cost when one answered more", () => {
    expect(verdict(made({ ms: 200, hits: 2 }, { ms: 1800, hits: 5 }), "pdfium")).toBe(
      "You picked Fast text. Here it answered 2 of 5 and Layout answered 5 of 5. Layout would have taken 9 times longer per page.",
    )
    expect(verdict(made({ ms: 200, hits: 2 }, { ms: 1800, hits: 5 }), "docling")).toBe(
      "You picked Layout. Here it answered 5 of 5 and Fast text answered 2 of 5. The cost: Layout took 9 times longer per page.",
    )
  })

  it("says the fast one wins on cost when both answered the same", () => {
    expect(verdict(made({ ms: 200, hits: 5 }, { ms: 1800, hits: 5 }), "docling")).toBe("Both answered 5 of 5, so the fast one wins on cost.")
  })
})

describe("ratio and seconds per page", () => {
  it("rounds Layout's milliseconds over Fast text's to a whole number, at least 1", () => {
    expect(ratio(made({ ms: 30, hits: 0 }, { ms: 100, hits: 0 }))).toBe(3)
    expect(ratio(made({ ms: 21, hits: 0 }, { ms: 2822, hits: 0 }))).toBe(134)
    expect(ratio(made({ ms: 100, hits: 0 }, { ms: 40, hits: 0 }))).toBe(1)
  })

  it("does not divide by zero when Fast text took under a millisecond", () => {
    expect(Number.isFinite(ratio(made({ ms: 0, hits: 0 }, { ms: 1000, hits: 0 })))).toBe(true)
  })

  it("gives seconds per page to one decimal, and under 0.1 below that", () => {
    const run = (ms: number) => ({ ms, chars: 1, hits: 0, ocr: false, excerpt: null })
    expect(perPage(run(6800), 2)).toBe(3.4)
    expect(perPage(run(11700), 3)).toBe(3.9)
    expect(secondsPerPage(run(6800), 2)).toBe("3.4")
    expect(secondsPerPage(run(21), 2)).toBe("under 0.1")
    expect(secondsPerPage(run(200), 2)).toBe("0.1")
  })

  it("takes the verdict's ratio and the table's numbers from the same recorded milliseconds", () => {
    for (const c of [...LAB.cases, LAB.baseline]) {
      expect(ratio(c)).toBe(Math.round(c.parsers.docling.ms / c.parsers.pdfium.ms))
      for (const p of ["pdfium", "docling"] as const) {
        expect(Number.isInteger(c.parsers[p].ms)).toBe(true)
        expect(perPage(c.parsers[p], c.pages)).toBe(Math.round((c.parsers[p].ms / 1000 / c.pages) * 10) / 10)
      }
    }
  })
})

describe("the rules", () => {
  const b = LAB.baseline
  const t = byName("table-of-figures")
  const col = byName("two-column-report")
  const s = byName("scanned-notes")

  it("puts the recorded numbers in four rules", () => {
    expect(RULES).toEqual(rules(b, t, col, s))
    expect(RULES).toHaveLength(4)
    expect(RULES[1]).toBe(
      `Columns: Layout. It costs ${ratio(col)} times more per page here, and it is the difference between finding every answer and finding ${col.parsers.pdfium.hits} of ${col.questions}.`,
    )
    expect(RULES[3]).toBe(`Scans: Layout with OCR, and budget for it. On this sample Layout with OCR took ${perPage(s.parsers.docling, s.pages)} seconds per page.`)
  })

  it("says the primer tied, or gives both scores", () => {
    const tie = { ...made({ ms: 20, hits: 10 }, { ms: 2000, hits: 10 }, "chunking-primer"), questions: 10 }
    const apart = { ...made({ ms: 20, hits: 8 }, { ms: 2000, hits: 10 }, "chunking-primer"), questions: 10 }
    expect(rules(tie, t, col, s)[0]).toBe(
      "Digital-born, one column, mostly prose: Fast text. On the primer it answered 10 of 10, the same as Layout, at a fraction of the cost.",
    )
    expect(rules(apart, t, col, s)[0]).toBe(
      "Digital-born, one column, mostly prose: Fast text. On the primer it answered 8 of 10 against Layout's 10, at a fraction of the cost.",
    )
  })

  it("says the table tied, or names Layout, and the table's situation follows", () => {
    const tie = { ...made({ ms: 20, hits: 6 }, { ms: 2000, hits: 6 }, "table-of-figures"), questions: 6 }
    const apart = { ...made({ ms: 20, hits: 3 }, { ms: 2000, hits: 6 }, "table-of-figures"), questions: 6 }
    expect(rules(b, tie, col, s)[2]).toBe(
      "Simple ruled tables: Fast text keeps the rows in reading order and answered 6 of 6, the same as Layout. Layout keeps the table as a table, which starts to matter when tables are wide or a chunk cutter needs their edges.",
    )
    expect(rules(b, apart, col, s)[2]).toBe("Tables: Layout. Fast text answered 3 of 6 here and Layout answered 6.")
    expect(situation(tie)).toBe(
      "Invoices, lab reports and study results put the numbers in a table. A text extractor keeps a simple ruled table's rows in reading order, but drops the ruling, so a chunk cutter cannot see where the table starts and ends. A layout parser keeps the table as a table.",
    )
    expect(situation(apart)).toBe(
      "Invoices, lab reports and study results put the numbers in a table. A parser that does not see the table turns rows into loose words.",
    )
    expect(SITUATION["table-of-figures"]).toBe(situation(t))
  })

  it("recaps OCR as a separate cost on top of Layout", () => {
    expect(RECAP[2]).toBe("OCR is a separate cost on top of Layout, and the only way in for a scan.")
  })
})

describe("missingExcerpt", () => {
  it("tells scattered words from nothing read", () => {
    const run = (chars: number) => ({ ms: 1, chars, hits: 0, ocr: false, excerpt: null })
    expect(missingExcerpt(run(100))).toBe("The answer's words do not appear together in this text.")
    expect(missingExcerpt(run(0))).toBe("Nothing was read.")
  })
})

describe("runLink", () => {
  it.each(LAB.cases.flatMap((c) => (["pdfium", "docling"] as const).map((p) => [c.name, p] as const)))("opens %s with %s on Build", (name, parser) => {
    const c = byName(name)
    const link = runLink(registry, c, parser)
    expect(link.startsWith("/build?pipeline=")).toBe(true)
    const decoded = decodePipeline(link.slice("/build?pipeline=".length), registry)!
    expect(decoded.name).toBe(`Parsing lab: ${c.title}, ${PARSER_LABEL[parser]}`)
    const source = decoded.graph.nodes.find((n) => n.stage === "source")!
    expect(source.config).toMatchObject({ sha: c.sha, filename: c.filename })
    const parse = decoded.graph.nodes.find((n) => n.stage === "parse")!
    expect(parse.transform).toBe(parser)
    expect(parse.config.do_ocr === true).toBe(c.parsers[parser].ocr)
    const query = decoded.graph.nodes.find((n) => n.stage === "query")!
    expect(query.config.text).toBe(c.question)
  })

  it("turns OCR on from the recording, not from the case's name", () => {
    const c = made({ ms: 20, hits: 0 }, { ms: 2000, hits: 0 }, "two-column-report")
    c.parsers.docling.ocr = true
    const decoded = decodePipeline(runLink(registry, c, "docling").slice("/build?pipeline=".length), registry)!
    expect(decoded.graph.nodes.find((n) => n.stage === "parse")!.config.do_ocr).toBe(true)
  })
})
