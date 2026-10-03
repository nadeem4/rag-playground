import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SegmentedControl } from "./SegmentedControl"

afterEach(cleanup)

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", disabled: true, title: "Needs a key" },
]

function setup(value = "a") {
  const onChange = vi.fn()
  render(<SegmentedControl label="Letters" options={OPTIONS} value={value} onChange={onChange} />)
  const group = within(screen.getByRole("group", { name: "Letters" }))
  return { onChange, button: (name: string) => group.getByRole("button", { name }) as HTMLButtonElement }
}

const classes = (el: Element) => el.className.split(/\s+/)

describe("SegmentedControl", () => {
  it("is a named group of buttons, and only the chosen one is pressed", () => {
    const { button } = setup("b")
    expect(button("Alpha").getAttribute("aria-pressed")).toBe("false")
    expect(button("Beta").getAttribute("aria-pressed")).toBe("true")
    expect(button("Gamma").getAttribute("aria-pressed")).toBe("false")
  })

  it("the pressed option has the accent wash fill, accent text and a 1 px accent ring; the others are flat", () => {
    const { button } = setup("a")
    const pressed = classes(button("Alpha"))
    expect(pressed).toContain("bg-accent-wash")
    expect(pressed).toContain("text-primary")
    expect(pressed).toContain("border-primary")
    const flat = classes(button("Beta"))
    expect(flat).not.toContain("bg-accent-wash")
    expect(flat).not.toContain("border-primary")
    expect(flat).toContain("border-transparent")
  })

  it("calls onChange with the option's value", () => {
    const { button, onChange } = setup("a")
    fireEvent.click(button("Beta"))
    expect(onChange).toHaveBeenCalledWith("b")
  })

  it("a disabled option cannot be chosen and carries its reason as a title", () => {
    const { button, onChange } = setup("a")
    expect(button("Gamma").disabled).toBe(true)
    expect(button("Gamma").title).toBe("Needs a key")
    fireEvent.click(button("Gamma"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("its buttons share the one set of button states", () => {
    const { button } = setup("a")
    expect(classes(button("Beta"))).toContain("active:scale-[0.98]")
  })

  it("with a caption, shows the group's name before the options and names the group by it", () => {
    render(<SegmentedControl label="Theme" caption="md" options={OPTIONS} value="a" onChange={() => {}} />)
    const group = screen.getByRole("group", { name: "Theme" })
    const caption = group.firstElementChild!
    expect(caption.textContent).toBe("Theme")
    expect(group.getAttribute("aria-labelledby")).toBe(caption.id)
    expect(classes(caption)).toEqual(expect.arrayContaining(["sr-only", "md:not-sr-only"]))
    cleanup()
    render(<SegmentedControl label="Theme" caption="always" options={OPTIONS} value="a" onChange={() => {}} />)
    expect(classes(screen.getByRole("group", { name: "Theme" }).firstElementChild!)).not.toContain("sr-only")
  })

  it("without a caption, the group is named by its aria-label and shows no words of its own", () => {
    setup()
    const group = screen.getByRole("group", { name: "Letters" })
    expect(group.getAttribute("aria-label")).toBe("Letters")
    expect(group.firstElementChild!.tagName).toBe("BUTTON")
  })
})
