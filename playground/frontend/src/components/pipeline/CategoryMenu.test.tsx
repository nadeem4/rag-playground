import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { choose, openPicker, optionNames } from "@/components/ui/pickerTesting"

import { CategoryMenu } from "./CategoryMenu"

afterEach(cleanup)

const CATS = [{ id: "default", name: "Default" }, { id: "reports", name: "Reports with tables" }]

describe("CategoryMenu", () => {
  it("lists each category and marks the current one", () => {
    render(<CategoryMenu categories={CATS} value="reports" onMove={() => {}} />)
    const trigger = screen.getByRole("button", { name: /Category.*Reports with tables/ })
    expect(optionNames(trigger)).toEqual(["Default", "Reports with tables"])
    openPicker(trigger)
    expect(screen.getByRole("option", { name: /Reports with tables/ }).getAttribute("aria-selected")).toBe("true")
  })

  it("calls onMove with the chosen id", () => {
    const onMove = vi.fn()
    render(<CategoryMenu categories={CATS} value="default" onMove={onMove} />)
    choose(screen.getByRole("button", { name: /Category/ }), "Reports with tables")
    expect(onMove).toHaveBeenCalledWith("reports")
  })

  it("closes on escape and returns focus", () => {
    render(<CategoryMenu categories={CATS} value="default" onMove={() => {}} />)
    const trigger = screen.getByRole("button", { name: /Category/ })
    fireEvent.keyDown(openPicker(trigger), { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("is not shown with one category", () => {
    const { container } = render(<CategoryMenu categories={[CATS[0]]} value="default" onMove={() => {}} />)
    expect(container.textContent).toBe("")
  })
})
