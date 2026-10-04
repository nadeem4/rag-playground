import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RecipeHead } from "./RecipeHead"

afterEach(cleanup)

const props = { name: "Recursive (natural breaks), 400 characters", code: "recursive_character", own: false }

describe("RecipeHead", () => {
  it("names the recipe in words and its code name in mono, with nothing to unfold", () => {
    render(<RecipeHead {...props} />)
    const name = screen.getByText(props.name)
    expect(name.className).toContain("text-base")
    expect(name.className).toContain("font-semibold")
    expect(screen.getByText("recursive_character").className).toContain("font-mono")
    expect(screen.queryByText("Your pipeline")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("offers Use on Build as a link button, then says Now on Build", () => {
    const onUse = vi.fn()
    const { rerender } = render(<RecipeHead {...props} onUse={onUse} />)
    const use = screen.getByRole("button", { name: "Use on Build" })
    expect(use.className.split(" ")).toContain("pointer-coarse:min-h-[44px]")
    fireEvent.click(use)
    expect(onUse).toHaveBeenCalled()
    rerender(<RecipeHead {...props} onUse={onUse} used />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Now on Build")).toBeTruthy()
  })

  it("tags the node's own recipe as Your pipeline", () => {
    render(<RecipeHead {...props} own />)
    expect(screen.getByText("Your pipeline")).toBeTruthy()
  })
})
