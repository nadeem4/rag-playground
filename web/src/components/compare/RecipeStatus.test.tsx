import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RecipeStatus } from "./RecipeStatus"

afterEach(cleanup)

describe("RecipeStatus", () => {
  it("says a running recipe with its seconds in mono, behind an accent dot", () => {
    render(<RecipeStatus status={{ kind: "running", shared: true, cached: false }} seconds={12} />)
    const line = screen.getByTestId("recipe-status")
    expect(line.textContent).toBe("Running the shared steps, then this recipe, 12 s")
    expect(line.querySelector(".font-mono")?.textContent).toBe("12 s")
    expect(line.querySelector("[data-dot]")?.className).toContain("bg-primary")
  })

  it("marks a waiting recipe with a flat dot", () => {
    render(<RecipeStatus status={{ kind: "waiting" }} seconds={null} />)
    expect(screen.getByTestId("recipe-status").querySelector("[data-dot]")?.className).toContain("bg-flat")
  })

  it("offers Change this recipe on a failure, as a link button with a 44 px box under a coarse pointer", () => {
    const onChange = vi.fn()
    render(<RecipeStatus status={{ kind: "failed", step: "Chunk", error: "ValueError: x" }} seconds={null} onChange={onChange} />)
    expect(screen.getByTestId("recipe-status").querySelector("[data-dot]")?.className).toContain("bg-danger")
    const b = screen.getByRole("button", { name: "Change this recipe" })
    expect(b.className.split(" ")).toContain("pointer-coarse:min-h-[44px]")
    fireEvent.click(b)
    expect(onChange).toHaveBeenCalled()
  })
})
