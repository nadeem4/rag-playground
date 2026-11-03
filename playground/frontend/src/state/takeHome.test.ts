import { describe, expect, it } from "vitest"

import type { PipelineConfig } from "./config"
import type { Question } from "./goldSet"
import type { Sorted } from "./sorting"
import type { DocRef } from "./sourceDocs"
import { categoryRows, defaultWhere, exportBody, forDocument, laptopQuestions, summary, unnamedCount } from "./takeHome"

const step = { use: "x" }
const def = (name: string) => ({ name, parse: step, chunk: step })
const config = {
  index: { store: step },
  categories: { reports: def("Reports"), notes: def("Notes") },
} as unknown as PipelineConfig

const doc = (sha: string, category?: string): DocRef => ({ sha, filename: `${sha}.pdf`, ...(category ? { category } : {}) })
const q = (id: string, document: string): Question => ({ id, question: `Q ${id}?`, gold_answers: ["g"], tags: [], answer: "", document })
const many = (n: number, document: string) => Array.from({ length: n }, (_, i) => q(`${document}-${i}`, document))
const none: Sorted = {}

describe("categoryRows", () => {
  it("a category with 10 own questions is ready", () => {
    const [r] = categoryRows(config, [doc("a", "reports")], none, many(10, "a"))
    expect(r).toMatchObject({ id: "reports", name: "Reports", count: 10, status: "ready", documents: ["a.pdf"] })
  })
  it("9 own questions is a weak check", () => {
    expect(categoryRows(config, [doc("a", "reports")], none, many(9, "a"))[0].status).toBe("weak")
  })
  it("questions on a sample only are counted but marked sample-only", () => {
    const [r] = categoryRows(config, [doc("a", "reports")], none, many(12, "a"), { sampleShas: ["a"] })
    expect(r).toMatchObject({ count: 12, status: "sample-only", sample: true })
  })
  it("a category with no document is not tested", () => {
    const rows = categoryRows(config, [doc("a", "reports")], none, many(10, "a"))
    expect(rows.find((r) => r.id === "notes")).toMatchObject({ status: "not-tested", count: 0, documents: [] })
  })
  it("a category is found from the pin or the sort rule (usedBy)", () => {
    const sorted: Sorted = { b: { category: "notes", reason: "Rule 1: x" } }
    const rows = categoryRows(config, [doc("a", "reports"), doc("b")], sorted, [...many(10, "a"), ...many(3, "b")])
    expect(rows.find((r) => r.id === "notes")).toMatchObject({ documents: ["b.pdf"], count: 3 })
  })
  it("questions that name no document are counted apart and never exported", () => {
    const qs = [...many(10, "a"), q("free", "")]
    const rows = categoryRows(config, [doc("a", "reports")], none, qs)
    expect(rows[0].count).toBe(10)
    expect(unnamedCount(qs)).toBe(1)
    expect(JSON.stringify(exportBody(config, "p", rows, defaultWhere()))).not.toContain("free")
  })
  it("a category is sample-only only when its questions come only from sample documents", () => {
    const docs = [doc("a", "reports"), doc("b", "notes")]
    const rows = categoryRows(config, docs, none, [...many(12, "a"), ...many(10, "b")], { sampleShas: ["a"] })
    expect(rows.find((r) => r.id === "reports")).toMatchObject({ status: "sample-only", sample: true })
    expect(rows.find((r) => r.id === "notes")).toMatchObject({ status: "ready", sample: false })
  })
  it("tags each document as a sample or the team's upload", () => {
    const [r] = categoryRows(config, [doc("a", "reports"), doc("b", "reports")], none, [], { sampleShas: ["a"] })
    expect(r.docs).toEqual([
      { filename: "a.pdf", tag: "Sample" },
      { filename: "b.pdf", tag: "Your upload" },
    ])
  })
  it("says in a sentence what each status means, with a mark", () => {
    const docs = [doc("a", "reports"), doc("b", "notes")]
    const [ready, weak] = categoryRows(config, docs, none, [...many(10, "a"), ...many(4, "b")])
    expect(ready).toMatchObject({ mark: "✓", text: "Enough of your own questions for the quality check to catch a problem." })
    expect(weak).toMatchObject({ mark: "!", text: "Only 4 questions. With so few, one bad change can slip through. Aim for 10 or more." })
  })
  it("names the action with a count and the category's own word", () => {
    const wide = { index: { store: step }, categories: { policies: def("Policies"), forms: def("Scanned forms"), reports: def("Reports") } } as unknown as PipelineConfig
    const docs = [doc("a", "reports"), doc("b", "policies")]
    const rows = categoryRows(wide, docs, none, [...many(4, "a"), ...many(12, "b")], { sampleShas: ["b"] })
    const by = (id: string) => rows.find((r) => r.id === id)!
    expect(by("reports").action).toEqual({ kind: "write", label: "Write 6 more questions" })
    expect(by("policies").action).toEqual({ kind: "add", label: "Add a policy document" })
    expect(by("forms").action).toEqual({ kind: "test", label: "Test a scanned form on Build" })
    expect(by("policies").text).toContain("These 12 questions are about our sample")
    expect(by("forms")).toMatchObject({ mark: "-", docs: [] })
  })
  it("a ready category has no action", () => {
    expect(categoryRows(config, [doc("a", "reports")], none, many(10, "a"))[0].action).toBeNull()
  })
})

describe("a pipeline with one plain category", () => {
  it("puts every document in the default category", () => {
    const plain = { index: { parse: step, chunk: step, store: step } } as unknown as PipelineConfig
    const [r] = categoryRows(plain, [doc("a")], none, many(10, "a"))
    expect(r).toMatchObject({ documents: ["a.pdf"], count: 10, status: "ready" })
  })
})

describe("exportBody with one plain category", () => {
  it("sends the config as it is and files the questions under default, which the server reads a plain pipeline as", () => {
    const plain = { index: { parse: step, chunk: step, store: step }, retrieve: { search: step } } as unknown as PipelineConfig
    const rows = categoryRows(plain, [doc("a")], none, many(2, "a"))
    const body = exportBody(plain, "p", rows, defaultWhere())
    expect(body.config).toEqual(plain)
    expect(Object.keys(body.categories)).toEqual(["default"])
  })
})

describe("summary", () => {
  it("counts ready categories and exported questions (samples excluded)", () => {
    const docs = [doc("a", "reports"), doc("b", "notes")]
    const qs = [...many(10, "a"), ...many(4, "b")]
    expect(summary(categoryRows(config, docs, none, qs))).toEqual({ ready: 1, questions: 14 })
    expect(summary(categoryRows(config, docs, none, qs, { sampleShas: ["a", "b"] }))).toEqual({ ready: 0, questions: 0 })
  })
})

describe("exportBody", () => {
  it("names documents by filename and sends the where-it-runs choices", () => {
    const rows = categoryRows(config, [doc("a", "reports")], none, many(2, "a"))
    const body = exportBody(config, "My pipeline", rows, { source: "./docs", index_store: "qdrant", index_url: "http://q:6333" })
    expect(body.name).toBe("My pipeline")
    expect(body.where.index_store).toBe("qdrant")
    expect(body.categories.reports.sample).toBe(false)
    expect(body.categories.reports.questions[0]).toMatchObject({ id: "a-0", document: "a.pdf", gold_answers: ["g"] })
  })
  it("omits sample categories' questions and sets sample true", () => {
    const rows = categoryRows(config, [doc("a", "reports")], none, many(2, "a"), { sampleShas: ["a"] })
    expect(exportBody(config, "p", rows, defaultWhere()).categories.reports).toEqual({ questions: [], sample: true })
  })
  it("does not send a category with no document", () => {
    const rows = categoryRows(config, [doc("a", "reports")], none, many(2, "a"))
    expect(Object.keys(exportBody(config, "p", rows, defaultWhere()).categories)).toEqual(["reports"])
  })
})

describe("forDocument", () => {
  it("tags every question of a one-document set with that document", () => {
    const set = [q("1", ""), { ...q("2", "old.pdf") }]
    expect(forDocument(set, "a").map((x) => x.document)).toEqual(["a", "a"])
    expect(set[0].document).toBe("")
  })
})

describe("laptopQuestions", () => {
  it("flattens the non-sample categories into one set, naming documents by filename", () => {
    const docs = [doc("a", "reports"), doc("b", "notes")]
    const rows = categoryRows(config, docs, none, [...many(2, "a"), ...many(2, "b")], { sampleShas: ["b"] })
    const set = laptopQuestions(rows) as { questions: { id: string; document: string }[] }
    expect(set.questions.map((x) => [x.id, x.document])).toEqual([["a-0", "a.pdf"], ["a-1", "a.pdf"]])
  })
  it("is undefined when there is nothing to send", () => {
    expect(laptopQuestions(categoryRows(config, [doc("a", "reports")], none, []))).toBeUndefined()
  })
})
