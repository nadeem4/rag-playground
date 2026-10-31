import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CategoryDef, RouteRule } from "@/state/config"
import type { CheckInfo } from "@/state/routes"

import { RoutesEditor } from "./RoutesEditor"

afterEach(cleanup)

const CHECKS: Record<string, CheckInfo> = {
  file_type: {
    name: "file_type",
    summary: "The file's type is one of the listed types.",
    config_schema: { type: "object", title: "FileTypeSettings", properties: { types: { type: "array", items: { type: "string" }, title: "Types" } } },
  },
  text_layer: { name: "text_layer", summary: "A PDF has text.", config_schema: { type: "object", title: "TextLayerSettings", properties: {} } },
}
const cat = (name: string): CategoryDef => ({ name, parse: { use: "p" }, chunk: { use: "c" } })
const CATEGORIES = { a: cat("Alpha"), b: cat("Beta") }
const ROUTE: RouteRule[] = [{ when: { use: "file_type", types: ["pdf"] }, category: "a" }, { when: { use: "text_layer" }, category: "b" }, { category: "a" }]

function show(route = ROUTE, onChange = vi.fn()) {
  render(<RoutesEditor route={route} categories={CATEGORIES} checks={CHECKS} onChange={onChange} />)
  return onChange
}

describe("RoutesEditor", () => {
  it("lists the rules in order", () => {
    show()
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain("Rule 1")
    expect(items[1].textContent).toContain("Rule 2")
    expect(items[2].textContent).toContain("Anything else")
  })

  it("moving a rule down changes the order", () => {
    const onChange = show()
    fireEvent.click(screen.getByRole("button", { name: "Move rule 1 down" }))
    expect((onChange.mock.calls[0][0] as RouteRule[]).map((r) => r.category)).toEqual(["b", "a", "a"])
  })

  it("a check's settings come from its schema", () => {
    show()
    expect(screen.getByText("Types")).toBeTruthy()
  })

  it("the last rule has no check and cannot be removed", () => {
    show()
    expect(screen.queryByRole("button", { name: "Remove rule 3" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Move rule 3 up" })).toBeNull()
    expect(screen.getByRole("button", { name: "Remove rule 1" })).toBeTruthy()
  })

  it("shows the new documents only note", () => {
    show()
    expect(screen.getByText("New documents only: documents already sorted stay where they are.")).toBeTruthy()
  })

  it("choosing another category changes that rule", () => {
    const onChange = show()
    fireEvent.change(screen.getByLabelText("Category of rule 1"), { target: { value: "b" } })
    expect((onChange.mock.calls[0][0] as RouteRule[])[0].category).toBe("b")
  })

  it("says what is wrong with the route", () => {
    show([{ category: "a" }, { category: "b" }])
    expect(screen.getByRole("alert").textContent).toContain("Rule 1 has no when")
  })
})
