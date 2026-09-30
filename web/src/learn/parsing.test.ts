import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { decodePipeline } from "@/state/pipelines"

import recorded from "./parsing-lab.json"
import { LAB, layoutRatio, type LabCase, PARSER_LABEL, perPage, ratio, RULES, runLink, SITUATION, verdict } from "./parsing"

const registry = liveRegistry as unknown as Registry
const byName = (name: string) => LAB.cases.find((c) => c.name === name)!

/** A case with made-up numbers, so the words can be checked exactly. */
function made(pdfium: { seconds: number; hits: number }, docling: { seconds: number; hits: number }): LabCase {
  const run = (r: { seconds: number; hits: number }) => ({ ...r, chars: 100, ocr: false, excerpt: null })
  return { ...LAB.cases[0], questions: 5, pages: 2, parsers: { pdfium: run(pdfium), docling: run(docling) } }
}

describe("the recording", () => {
  it("is the committed JSON, three cases in order, each with a situation", () => {
    expect(LAB).toEqual(recorded)
    expect(LAB.cases.map((c) => c.name)).toEqual(["two-column-report", "table-of-figures", "scanned-notes"])
    for (const c of LAB.cases) expect(SITUATION[c.name]).toBeTruthy()
    expect(PARSER_LABEL).toEqual({ pdfium: "Fast text", docling: "Layout" })
  })
})

describe("verdict", () => {
  it("names the pick, both scores and the cost when one answered more", () => {
    expect(verdict(made({ seconds: 0.2, hits: 2 }, { seconds: 1.8, hits: 5 }), "pdfium")).toBe(
      "You picked Fast text. Here it answered 2 of 5 and Layout answered 5 of 5. The cost: Layout took 9 times longer per page.",
    )
    expect(verdict(made({ seconds: 0.2, hits: 2 }, { seconds: 1.8, hits: 5 }), "docling")).toBe(
      "You picked Layout. Here it answered 5 of 5 and Fast text answered 2 of 5. The cost: Layout took 9 times longer per page.",
    )
  })

  it("says the fast one wins on cost when both answered the same", () => {
    expect(verdict(made({ seconds: 0.2, hits: 5 }, { seconds: 1.8, hits: 5 }), "docling")).toBe("Both answered 5 of 5, so the fast one wins on cost.")
  })
})

describe("ratio and seconds per page", () => {
  it("rounds Layout's seconds over Fast text's to a whole number, at least 1", () => {
    expect(ratio(made({ seconds: 0.3, hits: 0 }, { seconds: 1.0, hits: 0 }))).toBe(3)
    expect(ratio(made({ seconds: 0.4, hits: 0 }, { seconds: 1.0, hits: 0 }))).toBe(3)
    expect(ratio(made({ seconds: 1.0, hits: 0 }, { seconds: 0.4, hits: 0 }))).toBe(1)
  })

  it("does not divide by zero when Fast text took under a tenth of a second", () => {
    expect(Number.isFinite(ratio(made({ seconds: 0, hits: 0 }, { seconds: 1.0, hits: 0 })))).toBe(true)
  })

  it("gives seconds per page to one decimal", () => {
    expect(perPage({ seconds: 6.8, chars: 1, hits: 0, ocr: false, excerpt: null }, 2)).toBe(3.4)
    expect(perPage({ seconds: 11.7, chars: 1, hits: 0, ocr: false, excerpt: null }, 3)).toBe(3.9)
  })

  it("puts the recorded numbers in the rules", () => {
    const digital = LAB.cases.filter((c) => c.name !== "scanned-notes")
    expect(RULES[1]).toContain(`It costs ${layoutRatio(digital)} times more per page here`)
    const scan = byName("scanned-notes")
    expect(RULES[2]).toContain(`OCR cost ${perPage(scan.parsers.docling, scan.pages)} seconds per page`)
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
    expect(parse.config.do_ocr === true).toBe(parser === "docling" && name === "scanned-notes")
    const query = decoded.graph.nodes.find((n) => n.stage === "query")!
    expect(query.config.text).toBe(c.question)
  })
})
