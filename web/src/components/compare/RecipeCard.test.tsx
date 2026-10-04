import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RecipeCard } from "./RecipeCard"

afterEach(cleanup)

const parts = [{ text: "Cut with " }, { text: "Recursive (natural breaks)", field: "transform" }, { text: " into pieces of " }, { text: "200 characters", field: "chunk_size" }, { text: "." }]
const props = { index: 1, own: false, tag: "Edited" as const, parts, code: "recursive_character", stage: "chunk" as const, placeholder: "After the run, this recipe becomes a column.", openField: null, onOpen: () => {} }

describe("RecipeCard", () => {
  it("is an article named by its place, its sentence with each value a button", () => {
    const onOpen = vi.fn()
    render(<RecipeCard {...props} onOpen={onOpen} onRemove={() => {}} />)
    const card = screen.getByRole("article", { name: "Recipe 2" })
    expect(card.className).toContain("min-h-[320px]")
    expect(card.className).toContain("rounded-panel")
    const value = screen.getByRole("button", { name: "Change chunk size, now 200 characters" })
    expect(value.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(value)
    expect(onOpen).toHaveBeenCalledWith("chunk_size", value)
    expect(screen.getByRole("button", { name: "Change the strategy, now Recursive (natural breaks)" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove recipe 2" })).toBeTruthy()
    expect(screen.getByTestId("recipe-code").textContent).toBe("recursive_character")
    expect(screen.getByText("After the run, this recipe becomes a column.")).toBeTruthy()
  })

  it("marks an edited recipe as Build marks a changed setting, and tints Your pipeline", () => {
    render(<RecipeCard {...props} />)
    expect(screen.getByText("Edited").className).toContain("bg-stale-wash")
    cleanup()
    render(<RecipeCard {...props} own tag="Your pipeline" />)
    expect(screen.getByRole("article", { name: "Your pipeline" }).className).toContain("bg-accent-wash")
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull()
  })

  it("gives each value a 44 px box under a coarse pointer", () => {
    render(<RecipeCard {...props} />)
    expect(screen.getByRole("button", { name: /^Change chunk size/ }).className.split(" ")).toContain("pointer-coarse:min-h-[44px]")
  })
})
