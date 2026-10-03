import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Button } from "./button"

afterEach(cleanup)

const classes = (el: Element) => el.className.split(/\s+/)

describe("Button states", () => {
  it("presses by scaling to 0.98 over the fast duration, not by moving down", () => {
    render(<Button>Save</Button>)
    const c = classes(screen.getByRole("button", { name: "Save" }))
    expect(c).toContain("active:scale-[0.98]")
    expect(c).toContain("duration-(--dur-fast)")
    // Tailwind 4 scales with the `scale` property, so that is what transitions.
    expect(c).toContain("transition-[scale,background-color,opacity]")
    expect(c).not.toContain("active:translate-y-px")
  })

  it("shows focus as a 2 px ring with a 2 px offset", () => {
    render(<Button>Save</Button>)
    const c = classes(screen.getByRole("button", { name: "Save" }))
    expect(c).toContain("focus-visible:outline-2")
    expect(c).toContain("focus-visible:outline-offset-2")
    expect(c).toContain("focus-visible:outline-(--focus-ring)")
  })

  it("is half opacity when disabled", () => {
    render(<Button disabled>Save</Button>)
    expect(classes(screen.getByRole("button", { name: "Save" }))).toContain("disabled:opacity-50")
  })

  it("busy disables the button, keeps its label and says it is busy", () => {
    const onClick = vi.fn()
    render(
      <Button busy onClick={onClick}>
        Building
      </Button>,
    )
    const b = screen.getByRole("button", { name: "Building" }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.textContent).toBe("Building")
    expect(b.getAttribute("aria-busy")).toBe("true")
    fireEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("is not busy by default", () => {
    render(<Button>Save</Button>)
    const b = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement
    expect(b.disabled).toBe(false)
    expect(b.hasAttribute("aria-busy")).toBe(false)
  })
})
