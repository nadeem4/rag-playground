import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { IndexTag } from "./IndexTag"

afterEach(cleanup)

const NAME = "0123456789abcdef-0123456789ab"

describe("IndexTag", () => {
  it("renders nothing without a name", () => {
    const { container } = render(<IndexTag name={null} />)
    expect(container.textContent).toBe("")
    render(<IndexTag name={undefined} />)
    expect(screen.queryByTestId("index-tag")).toBeNull()
  })

  it("shows the short name and the full name in its title", () => {
    render(<IndexTag name={NAME} />)
    const tag = screen.getByTestId("index-tag")
    expect(tag.textContent).toBe("Index 012345-012345")
    expect(tag.getAttribute("title")).toBe(`Searched index ${NAME}`)
    expect(tag.className).toContain("font-mono")
  })
})
