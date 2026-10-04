import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OpenView } from "./OpenView"

afterEach(cleanup)

const chips = [
  { i: 0, label: "Your pipeline", kind: "done" as const },
  { i: 1, label: "200 characters", kind: "done" as const },
  { i: 2, label: "By sentence", kind: "running" as const },
  { i: 3, label: "By heading", kind: "failed" as const },
]

describe("OpenView", () => {
  it("names the way back, marks the open chips, and keeps unfinished chips disabled with their state", () => {
    const onBack = vi.fn()
    const onChip = vi.fn()
    render(
      <OpenView total={4} shown={[0, 1]} chips={chips} onChip={onChip} onBack={onBack} nextLine={null} position={null} onStep={() => {}} note={null}>
        <div />
      </OpenView>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Back to all four recipes" }))
    expect(onBack).toHaveBeenCalled()
    expect(screen.getByText("Two of four, side by side")).toBeTruthy()
    const strip = screen.getByRole("group", { name: "All four recipes" })
    expect(strip.className).toContain("overflow-x-auto")
    const buttons = within(strip).getAllByRole("button")
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Your pipeline", "200 characters", "By sentence, running", "By heading, failed"])
    expect(buttons.filter((b) => b.getAttribute("aria-current") === "true")).toHaveLength(2)
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(buttons[1])
    expect(onChip).toHaveBeenCalledWith(1)
  })

  it("puts Previous and Next around where the one recipe sits, and the next line in a live region", () => {
    const onStep = vi.fn()
    render(
      <OpenView total={4} shown={[0, 1]} chips={chips} onChip={() => {}} onBack={() => {}} nextLine="Next: By sentence. Press Next or the right arrow key." position={{ at: 1, of: 3, beside: true, prev: false, next: true }} onStep={onStep} note={null}>
        <div />
      </OpenView>,
    )
    expect(screen.getByText("1 of 3, each beside Your pipeline")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(onStep).toHaveBeenCalledWith(1)
    expect(screen.getByText(/^Next: By sentence/).getAttribute("aria-live")).toBe("polite")
  })
})
