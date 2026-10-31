import { describe, expect, it } from "vitest"

import type { RouteRule } from "./config"
import { addCheck, addRule, moveRule, removeCheck, removeRule, routeProblem, ruleSentence, setCategory, setCheck, type CheckInfo } from "./routes"

const CHECKS: Record<string, CheckInfo> = {
  file_type: { name: "file_type", summary: "The file's type is one of the listed types.", config_schema: { type: "object" } },
  text_layer: { name: "text_layer", summary: "A PDF has text you can select.", config_schema: { type: "object" } },
  custom_check: { name: "custom_check", summary: "Is an invoice.", config_schema: { type: "object" } },
}
const ROUTE: RouteRule[] = [
  { when: { use: "file_type", types: ["pdf"] }, category: "a" },
  { when: [{ use: "text_layer", has: false }], category: "b" },
  { category: "c" },
]

describe("rules", () => {
  it("moving a rule keeps the default last", () => {
    expect(moveRule(ROUTE, 0, 1).map((r) => r.category)).toEqual(["b", "a", "c"])
    expect(moveRule(ROUTE, 1, 2)).toEqual(ROUTE)
    expect(moveRule(ROUTE, 2, 0)).toEqual(ROUTE)
  })

  it("removing the default is refused", () => {
    expect(removeRule(ROUTE, 2)).toEqual(ROUTE)
    expect(removeRule(ROUTE, 0).map((r) => r.category)).toEqual(["b", "c"])
  })

  it("a new rule goes before the default", () => {
    const next = addRule(ROUTE, 99, { use: "name", pattern: "*" })
    expect(next.map((r) => r.category)).toEqual(["a", "b", "c", "c"])
    expect(next[2].when).toEqual({ use: "name", pattern: "*" })
    expect(next[3].when).toBeUndefined()
  })

  it("setCheck, addCheck and removeCheck edit one rule's checks", () => {
    const set = setCheck(ROUTE, 0, 0, { use: "file_type", types: ["docx"] })
    expect(set[0].when).toEqual({ use: "file_type", types: ["docx"] })
    const two = addCheck(ROUTE, 0, { use: "text_layer", has: true })
    expect(two[0].when).toEqual([{ use: "file_type", types: ["pdf"] }, { use: "text_layer", has: true }])
    expect(removeCheck(two, 0, 1)[0].when).toEqual({ use: "file_type", types: ["pdf"] })
    expect(removeCheck(ROUTE, 0, 0)).toEqual(ROUTE)
  })

  it("setCategory changes the category of one rule", () => {
    expect(setCategory(ROUTE, 2, "a")[2].category).toBe("a")
  })
})

describe("ruleSentence", () => {
  it("joins the checks with and", () => {
    const rule: RouteRule = { when: [{ use: "file_type", types: ["pdf"] }, { use: "text_layer", has: false }], category: "b" }
    expect(ruleSentence(rule, CHECKS, "Scanned PDFs")).toBe("When the file type is pdf and the PDF has no text layer, use Scanned PDFs.")
  })

  it("leaves out a blank entry the list field has just added", () => {
    const rule: RouteRule = { when: { use: "file_type", types: ["pdf", "", "  "] }, category: "b" }
    expect(ruleSentence(rule, CHECKS, "X")).toBe("When the file type is pdf, use X.")
  })

  it("the last rule says anything else", () => {
    expect(ruleSentence({ category: "c" }, CHECKS, "Default")).toBe("Anything else uses Default.")
  })

  it("a check the app has no wording for uses its summary", () => {
    expect(ruleSentence({ when: { use: "custom_check" }, category: "c" }, CHECKS, "X")).toBe("When is an invoice, use X.")
  })

  it("has no dashes", () => {
    expect(ruleSentence(ROUTE[0], CHECKS, "A")).not.toMatch(/[\u2013\u2014]/)
  })
})

describe("routeProblem", () => {
  const cats = { a: {}, b: {}, c: {} }
  it("is null for a good route", () => {
    expect(routeProblem(ROUTE, cats)).toBeNull()
  })
  it("refuses a route with no rules", () => {
    expect(routeProblem([], cats)).toMatch(/no route/)
  })
  it("refuses a last rule that has a when", () => {
    expect(routeProblem([ROUTE[0]], cats)).toBe("The last rule of route must have no when, so every document goes to some category.")
  })
  it("refuses a default in the middle", () => {
    expect(routeProblem([{ category: "a" }, { category: "c" }], cats)).toBe(
      "Rule 1 has no when, so it takes every document and the rules after it can never run. Only the last rule may leave out when.",
    )
  })
  it("refuses a missing category", () => {
    expect(routeProblem([{ category: "zzz" }], cats)).toBe("Rule 1 names the category 'zzz', which is not under categories. The categories are: 'a', 'b', 'c'.")
  })
})
