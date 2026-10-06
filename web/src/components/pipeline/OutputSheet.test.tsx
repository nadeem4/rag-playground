import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OutputSheet } from "./OutputSheet"

afterEach(cleanup)

function open(onClose = vi.fn()) {
  render(
    <>
      <button type="button">See Chunk output</button>
      <OutputSheet title="Chunk" sub="Recursive (natural breaks), recursive_character" onClose={onClose}>
        <p>Made 6 chunks.</p>
      </OutputSheet>
    </>,
  )
  return onClose
}

describe("the output sheet", () => {
  it("is a dialog named for its step, with the strategy under the name and the output inside", () => {
    open()
    const dialog = screen.getByRole("dialog", { name: "Chunk output" })
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(dialog.textContent).toContain("Recursive (natural breaks), recursive_character")
    expect(dialog.textContent).toContain("Made 6 chunks.")
  })

  it("moves focus to the close button, and the close button, Escape and the dimmed page close it", () => {
    const onClose = open()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close the output" }))
    fireEvent.click(screen.getByRole("button", { name: "Close the output" }))
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.click(screen.getByTestId("output-backdrop"))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("keeps the page behind it still while open, and lets it scroll again once closed", () => {
    open()
    expect(document.body.style.overflow).toBe("hidden")
    cleanup()
    expect(document.body.style.overflow).toBe("")
  })

  it("gives focus back to the button that opened it when it closes", () => {
    render(<button type="button">See Chunk output</button>)
    const opener = screen.getByRole("button", { name: "See Chunk output" })
    opener.focus()
    const { unmount } = render(
      <OutputSheet title="Chunk" sub="" onClose={vi.fn()}>
        <p>x</p>
      </OutputSheet>,
    )
    unmount()
    expect(document.activeElement).toBe(opener)
  })
})
