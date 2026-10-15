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

  it("marks the recipe the server names best, and no other", () => {
    const { rerender } = render(<RecipeHead {...props} best />)
    expect(screen.getByText("Best")).toBeTruthy()
    expect(screen.getByRole("heading").textContent).toBe(`${props.name} Best`)
    rerender(<RecipeHead {...props} />)
    expect(screen.queryByText("Best")).toBeNull()
  })

  it("says the recipe's time, tokens and cost on one line under its head, and nothing for an older result", () => {
    const cost = { seconds: 2.71, input_tokens: 4120, output_tokens: 96, dollars: 0.0046, unpriced_models: [], uncounted_models: [], steps_run: 1, steps_cached: 0, prices_as_of: "2026-10-15" }
    const { rerender } = render(<RecipeHead {...props} cost={cost} />)
    expect(screen.getByTestId("recipe-cost").textContent).toBe("2.7 s · 4,120 in / 96 out · $0.0046")
    rerender(<RecipeHead {...props} />)
    expect(screen.queryByTestId("recipe-cost")).toBeNull()
  })
})
