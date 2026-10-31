import { describe, expect, it } from "vitest"

import { addFromTemplate, copyCategory, moveToNew, removeCategory, renameCategory, usedBy } from "./categories"
import { categoriesOf, type PipelineConfig } from "./config"
import type { DocRef } from "./sourceDocs"
import type { IndexTemplate } from "./templates"

const OLD: PipelineConfig = {
  index: { parse: { use: "pdfium" }, chunk: { use: "fixed", size: 200 }, store: { use: "lancedb" } },
}
const TWO: PipelineConfig = {
  index: { store: { use: "lancedb" } },
  categories: {
    default: { name: "Default", parse: { use: "pdfium" }, chunk: { use: "fixed" } },
    reports: { name: "Reports", template: "tables", parse: { use: "docling" }, chunk: { use: "layout" } },
  },
  route: [{ when: { use: "name_matches", pattern: "r*" }, category: "reports" }, { category: "default" }],
}
const DOCS: DocRef[] = [
  { sha: "a", filename: "a.pdf", category: "reports" },
  { sha: "b", filename: "b.pdf" },
  { sha: "c", filename: "c.pdf", category: "default" },
]
const SORTED = { a: { category: "reports", reason: "Chosen when added" }, b: { category: "reports", reason: "Rule 1: x" }, c: { category: "default", reason: "Chosen when added" } }

describe("usedBy", () => {
  it("counts pinned and sorted documents", () => {
    expect(usedBy(DOCS, SORTED, "reports").map((d) => d.sha)).toEqual(["a", "b"])
    expect(usedBy(DOCS, SORTED, "default").map((d) => d.sha)).toEqual(["c"])
  })
})

describe("copyCategory", () => {
  it("gives a unique id and keeps the settings", () => {
    const one = copyCategory(TWO, "reports", "Reports")
    expect(one.id).toBe("reports-2")
    const two = copyCategory(one.config, "reports", "Reports")
    expect(two.id).toBe("reports-3")
    const made = categoriesOf(one.config)["reports-2"]
    expect(made).toEqual({ ...TWO.categories!.reports, name: "Reports" })
  })

  it("moves an old config to the new shape", () => {
    const { config, id } = copyCategory(OLD, "default", "Scans")
    expect(id).toBe("scans")
    expect(Object.keys(config.categories!)).toEqual(["default", "scans"])
  })
})

describe("moveToNew", () => {
  it("changes only that document's pin", () => {
    const r = moveToNew(TWO, DOCS, "a", "reports", "Big tables")
    expect(r.docs.map((d) => d.category)).toEqual(["big-tables", undefined, "default"])
    expect(categoriesOf(r.config)["big-tables"].name).toBe("Big tables")
    expect(r.config.route).toEqual(TWO.route)
  })
})

describe("removeCategory", () => {
  it("is refused with the names of its documents", () => {
    const r = removeCategory(TWO, "reports", usedBy(DOCS, SORTED, "reports"))
    expect(r).toEqual({ ok: false, problem: expect.stringContaining("a.pdf, b.pdf") })
  })

  it("is refused when a route names it", () => {
    const r = removeCategory(TWO, "reports", [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toContain("Rule 1")
  })

  it("is refused for the last category", () => {
    const r = removeCategory(OLD, "default", [])
    expect(r.ok).toBe(false)
  })

  it("removes an unused category and a config left with one default goes back to the old shape", () => {
    const loose: PipelineConfig = { ...TWO, route: [{ category: "default" }] }
    const r = removeCategory(loose, "reports", [])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.categories).toBeUndefined()
    if (r.ok) expect(r.config.index.parse).toEqual({ use: "pdfium" })
  })
})

describe("renameCategory", () => {
  it("changes only that category's name", () => {
    const c = renameCategory(TWO, "reports", "Big reports")
    expect(c.categories!.reports.name).toBe("Big reports")
    expect(c.categories!.default).toEqual(TWO.categories!.default)
  })
})

describe("addFromTemplate", () => {
  it("copies the template's settings and records template", () => {
    const t: IndexTemplate = {
      id: "scanned",
      name: "Scanned pages",
      summary: "",
      good_for: "",
      pipeline: { category: { parse: { use: "ocr" }, clean: [{ use: "strip" }], chunk: { use: "fixed" } } },
    }
    const { config, id } = addFromTemplate(OLD, t)
    expect(id).toBe("scanned-pages")
    expect(config.categories![id]).toEqual({ name: "Scanned pages", template: "scanned", parse: { use: "ocr" }, clean: [{ use: "strip" }], chunk: { use: "fixed" } })
  })
})
