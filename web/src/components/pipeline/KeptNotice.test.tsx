import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import { KEPT_KEY, resetWorkingForTests } from "@/state/working"

import { KeptNotice } from "./KeptNotice"

beforeEach(() => {
  window.localStorage.clear()
  resetWorkingForTests()
})

describe("KeptNotice", () => {
  it("says once why the old pipeline did not open, and that it is kept", () => {
    window.localStorage.setItem(KEPT_KEY, JSON.stringify({ problem: "It has an enrich step, and a pipeline in this version has no place for one.", seen: false }))
    render(<KeptNotice />)
    expect(screen.getByText(/could not be opened here/)).toBeTruthy()
    expect(screen.getByText(/still kept in this browser/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Got it" }))
    expect(screen.queryByText(/could not be opened here/)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(KEPT_KEY)!).seen).toBe(true)
  })

  it("says nothing when every old pipeline opened", () => {
    const { container } = render(<KeptNotice />)
    expect(container.textContent).toBe("")
  })
})
