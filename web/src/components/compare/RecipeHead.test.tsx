import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RecipeHead } from "./RecipeHead"

afterEach(cleanup)

const props = { name: "Recursive (natural breaks), 400 characters", code: "recursive_character", own: false, edited: false, open: false, controls: "ed0", onToggle: () => {} }

describe("RecipeHead", () => {
  it("names the recipe in words, its code name in mono, and offers to change it", () => {
    render(<RecipeHead {...props} />)
    const name = screen.getByText(props.name)
    expect(name.className).toContain("text-base")
    expect(name.className).toContain("font-semibold")
    expect(screen.getByText("recursive_character").className).toContain("font-mono")
    const change = screen.getByRole("button", { name: "Change this recipe" })
    expect(change.getAttribute("aria-expanded")).toBe("false")
    expect(change.getAttribute("aria-controls")).toBe("ed0")
    expect(screen.queryByText("Your pipeline")).toBeNull()
  })

  it("tags the node's own recipe as Your pipeline", () => {
    render(<RecipeHead {...props} own />)
    expect(screen.getByText("Your pipeline")).toBeTruthy()
  })

  it("reads Done while the editor is open, and asks to toggle it", () => {
    const onToggle = vi.fn()
    render(<RecipeHead {...props} open onToggle={onToggle} />)
    const done = screen.getByRole("button", { name: "Done" })
    expect(done.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(done)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("says the recipe was edited since the last run, while the editor is folded", () => {
    render(<RecipeHead {...props} edited />)
    const line = screen.getByText(/Edited since the last run/)
    // Marked as Build marks a changed setting.
    expect(line.className).toContain("text-stale")
    expect(line.className).toContain("bg-stale-wash")
  })

  it("gives the link button a 44 px box under a coarse pointer", () => {
    render(<RecipeHead {...props} />)
    const change = screen.getByRole("button", { name: "Change this recipe" })
    expect(change.className.split(" ")).toContain("pointer-coarse:min-h-[44px]")
  })
})
