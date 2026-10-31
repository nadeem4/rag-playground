import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PipelineConfig } from "@/state/config"
import type { DocRef } from "@/state/sourceDocs"
import type { IndexTemplate } from "@/state/templates"

import { CategoryEditor, NewCategoryForm } from "./CategoryEditor"

afterEach(cleanup)

const CONFIG: PipelineConfig = {
  index: { store: { use: "lancedb" } },
  categories: {
    default: { name: "Default", parse: { use: "pdfium" }, chunk: { use: "fixed" } },
    reports: { name: "Reports", template: "tables", parse: { use: "docling" }, chunk: { use: "layout" } },
  },
  route: [{ when: { use: "name_matches" }, category: "reports" }, { category: "default" }],
}
const TEMPLATES: IndexTemplate[] = [
  { id: "tables", name: "Reports with tables", summary: "", good_for: "", pipeline: { category: { parse: { use: "docling" }, chunk: { use: "layout" } } } },
  { id: "scanned", name: "Scanned pages", summary: "", good_for: "", pipeline: { category: { parse: { use: "ocr" }, chunk: { use: "fixed" } } } },
]
const doc = (n: number): DocRef => ({ sha: `s${n}`, filename: `f${n}.pdf` })

function show(id: string, users: DocRef[], onChange = vi.fn()) {
  render(<CategoryEditor id={id} config={CONFIG} users={users} templates={TEMPLATES} onChange={onChange} />)
  return onChange
}

describe("CategoryEditor", () => {
  it("says Used by 2 documents", () => {
    show("reports", [doc(1), doc(2)])
    expect(screen.getByText("Used by 2 documents")).toBeTruthy()
  })

  it("says Used by 1 document in the singular", () => {
    show("reports", [doc(1)])
    expect(screen.getByText("Used by 1 document")).toBeTruthy()
  })

  it("names the template it started from", () => {
    show("reports", [])
    expect(screen.getByText("Started from Reports with tables")).toBeTruthy()
  })

  it("renaming changes only this category", () => {
    const onChange = show("reports", [])
    fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Big reports" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByLabelText("Category name"))
    const next = onChange.mock.calls[0][0] as PipelineConfig
    expect(next.categories!.reports.name).toBe("Big reports")
    expect(next.categories!.default).toEqual(CONFIG.categories!.default)
  })

  it("can be cleared and retyped, and an empty name keeps the previous one", () => {
    const onChange = show("reports", [])
    const field = screen.getByLabelText("Category name") as HTMLInputElement
    fireEvent.change(field, { target: { value: "" } })
    expect(field.value).toBe("")
    fireEvent.blur(field)
    expect(onChange).not.toHaveBeenCalled()
    expect(field.value).toBe("Reports")
  })

  it("an empty name on the default category falls back to Default", () => {
    const onChange = vi.fn()
    render(<CategoryEditor id="default" config={{ ...CONFIG, categories: { ...CONFIG.categories!, default: { parse: { use: "pdfium" }, chunk: { use: "fixed" } } } }} users={[]} templates={TEMPLATES} onChange={onChange} />)
    const field = screen.getByLabelText("Category name") as HTMLInputElement
    expect(field.value).toBe("Default")
    fireEvent.change(field, { target: { value: " " } })
    fireEvent.blur(field)
    expect(field.value).toBe("Default")
  })

  it("Remove explains which documents use the category", () => {
    show("reports", [doc(1), doc(2)])
    const remove = screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    expect(screen.getByText(/f1\.pdf, f2\.pdf/)).toBeTruthy()
  })

  it("Add a category from a template adds a card with the template's name", () => {
    const onChange = show("default", [])
    fireEvent.click(screen.getByRole("button", { name: "Add a category" }))
    fireEvent.click(screen.getByRole("button", { name: /Scanned pages/ }))
    const next = onChange.mock.calls[0][0] as PipelineConfig
    expect(next.categories!["scanned-pages"]).toMatchObject({ name: "Scanned pages", template: "scanned" })
  })
})

describe("NewCategoryForm", () => {
  it("asks for a name and hands it over", () => {
    const onSubmit = vi.fn()
    render(<NewCategoryForm onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name of the new category"), { target: { value: "Big tables" } })
    fireEvent.click(screen.getByRole("button", { name: "Move" }))
    expect(onSubmit).toHaveBeenCalledWith("Big tables")
  })

  it("does not move without a name", () => {
    render(<NewCategoryForm onSubmit={() => {}} onCancel={() => {}} />)
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("CategoriesSection routes", () => {
  it("shows the Routes editor when the server lists checks", async () => {
    const { CategoriesSection } = await import("./CategoryEditor")
    render(<CategoriesSection shown="default" config={CONFIG} usersOf={() => []} checks={{}} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Categories" }))
    expect(screen.getByText("Routes")).toBeTruthy()
  })
})
