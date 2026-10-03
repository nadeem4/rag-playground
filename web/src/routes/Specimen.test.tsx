import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Specimen } from "./Specimen"

afterEach(cleanup)

const section = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement

describe("the specimen page", () => {
  it("shows the three surfaces, the raised one with the one shadow", () => {
    render(<Specimen />)
    const s = within(section("Surfaces"))
    expect(s.getByText("Page")).toBeTruthy()
    expect(s.getByText("Panel")).toBeTruthy()
    expect(s.getByText("Raised").closest(".shadow-raised")).toBeTruthy()
    expect(s.getAllByText("#fdfdfc").length).toBeGreaterThan(0)
    expect(s.getAllByText("#1f2023").length).toBeGreaterThan(0)
    expect(s.getByText("--shadow-raised-phone")).toBeTruthy()
    expect(s.getByText("0 1px 2px rgb(24 24 27 / 0.06)")).toBeTruthy()
  })

  it("lists the motion tokens with their values", () => {
    render(<Specimen />)
    const s = within(section("Motion"))
    for (const [name, value] of [
      ["--dur-fast", "120ms"],
      ["--dur-mid", "200ms"],
      ["--dur-slow", "320ms"],
      ["--dur-breathe", "1200ms"],
      ["--ease-in", "cubic-bezier(0.2, 0, 0, 1)"],
      ["--ease-out", "cubic-bezier(0.4, 0, 1, 1)"],
    ]) {
      expect(s.getByText(name)).toBeTruthy()
      expect(s.getByText(value)).toBeTruthy()
    }
  })

  it("shows the stale pair in both themes with its ratio", () => {
    render(<Specimen />)
    const s = within(section("Stale"))
    expect(s.getAllByText(/changed, run again/)).toHaveLength(2)
    expect(s.getAllByText(/^\d+\.\d:1$/)).toHaveLength(2)
  })

  it("previews the more contrast variant from the contrast block", () => {
    render(<Specimen />)
    const s = within(section("More contrast"))
    expect(s.getByText("--text-secondary")).toBeTruthy()
    expect(s.getByText("var(--text-primary)")).toBeTruthy()
    expect(s.getByText("--hairline")).toBeTruthy()
    expect(s.getAllByText("0 0 0 1px var(--field-border)").length).toBeGreaterThan(0)
    // Secondary text on the panel, before and after, in both themes.
    expect(s.getAllByText(/\d+\.\d:1/).length).toBeGreaterThanOrEqual(4)
  })
})
