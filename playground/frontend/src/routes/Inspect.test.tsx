import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Inspect } from "./Inspect"

afterEach(cleanup)

describe("the inspector gallery", () => {
  it("shows the summary row for the empty chunk set, with 0 chunks", () => {
    render(<Inspect />)
    const section = screen.getByRole("heading", { level: 2, name: "Empty chunk set" }).closest("section") as HTMLElement
    const s = within(section)
    expect(s.getByTestId("summary-chunks").textContent).toBe("0")
    expect(s.getByTestId("summary-median").textContent).toBe("n/a")
  })
})
