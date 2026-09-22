import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readLearnMode, resetLearnModeForTests, setLearnMode, useLearnMode } from "./learnMode"

beforeEach(() => {
  window.localStorage.clear()
  resetLearnModeForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Probe() {
  const on = useLearnMode()
  return <p>{on ? "on" : "off"}</p>
}

describe("learn mode", () => {
  it("is on for a first-time visitor", () => {
    expect(readLearnMode()).toBe(true)
  })

  it("remembers that it was turned off", () => {
    setLearnMode(false)
    resetLearnModeForTests()
    expect(readLearnMode()).toBe(false)
  })

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readLearnMode()).toBe(true)
    setLearnMode(false)
    expect(readLearnMode()).toBe(false)
  })

  it("re-renders every reader when it changes", () => {
    render(<Probe />)
    expect(screen.getByText("on")).toBeTruthy()
    act(() => setLearnMode(false))
    expect(screen.getByText("off")).toBeTruthy()
  })
})
