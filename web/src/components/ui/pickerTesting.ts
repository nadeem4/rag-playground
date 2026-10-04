import { fireEvent, screen, within } from "@testing-library/react"

/**
 * Drive a Picker the way a user does, for tests: press the trigger, then the
 * option. The list sits in a portal, so it is found on the whole screen.
 */
export function openPicker(trigger: HTMLElement): HTMLElement {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger)
  return screen.getByRole("listbox")
}

/** Open the picker and press the option whose name starts with `name`, or matches it. */
export function choose(trigger: HTMLElement, name: string | RegExp): void {
  const list = openPicker(trigger)
  fireEvent.click(within(list).getByRole("option", { name: typeof name === "string" ? new RegExp(`^${escape(name)}`) : name }))
}

/** The option for `name` in the open list, opening it first. */
export function optionOf(trigger: HTMLElement, name: string | RegExp): HTMLElement {
  const list = openPicker(trigger)
  return within(list).getByRole("option", { name: typeof name === "string" ? new RegExp(`^${escape(name)}`) : name })
}

/** The plain names of the options, as listed, then the list closes again. */
export function optionNames(trigger: HTMLElement): string[] {
  const list = openPicker(trigger)
  const names = within(list)
    .getAllByRole("option")
    .map((o) => o.querySelector("[data-name]")?.textContent ?? "")
  fireEvent.keyDown(list, { key: "Escape" })
  return names
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
