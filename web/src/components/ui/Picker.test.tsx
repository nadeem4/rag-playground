import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Picker, type PickerOption } from "./Picker"
import { choose, openPicker } from "./pickerTesting"

afterEach(cleanup)

const OPTIONS: PickerOption[] = [
  { value: "recursive_character", name: "Recursive (natural breaks)", code: "recursive_character", help: "Cuts at paragraph breaks first." },
  {
    value: "layout_blocks",
    name: "By layout block",
    code: "layout_blocks",
    help: "Cuts along the page's own blocks.",
    lock: { kind: "soft", reason: "Needs headings from the parse step. Fast text does not find any, so it cuts by size." },
  },
  {
    value: "markdown_header",
    name: "By heading",
    code: "markdown_header",
    help: "Cuts at headings.",
    lock: { kind: "hard", reason: "Needs headings from the parse step. Fast text does not provide it, so this cannot run." },
  },
  { value: "token_based", name: "Fixed token count", code: "token_based", help: "Counts tokens." },
  { value: "llm_rerank", name: "LLM reranker", code: "llm_rerank", help: "Asks a chat model.", needsKey: true },
  { value: "beta", name: "Beta", code: "beta", tags: [{ label: "Edited since saved", tone: "soft" }] },
]

function setup(value = "recursive_character", options = OPTIONS) {
  const onChange = vi.fn()
  const r = render(
    <div>
      <span id="lbl">Strategy</span>
      <Picker id="pk" labelledBy="lbl" options={options} value={value} onChange={onChange} />
      <button type="button">Elsewhere</button>
    </div>,
  )
  const trigger = () => screen.getByRole("button", { name: /^Strategy/ })
  return { onChange, trigger, ...r }
}

const listbox = () => screen.getByRole("listbox", { name: "Strategy" })
const option = (name: RegExp) => within(listbox()).getByRole("option", { name })
const active = () => document.getElementById(listbox().getAttribute("aria-activedescendant") ?? "")

describe("Picker, closed", () => {
  it("shows the plain name, the code name under it, and is named by the field label", () => {
    const { trigger } = setup()
    const t = trigger()
    expect(t.textContent).toContain("Recursive (natural breaks)")
    expect(t.textContent).toContain("recursive_character")
    expect(t.getAttribute("aria-haspopup")).toBe("listbox")
    expect(t.getAttribute("aria-expanded")).toBe("false")
    expect(t.getAttribute("aria-labelledby")).toBe("lbl pk")
    expect(t.className).toContain("min-h-[44px]")
    expect(t.getAttribute("data-picked")).toBe("recursive_character")
  })

  it("uses the option's own second line when it has no code name", () => {
    setup("p1", [{ value: "p1", name: "Resume", help: "Docling, Recursive, Hybrid (RRF)" }])
    expect(screen.getByRole("button", { name: /^Strategy/ }).textContent).toContain("Docling, Recursive, Hybrid (RRF)")
  })

  it("says nothing under itself for a plain pick", () => {
    setup()
    expect(screen.queryByTestId("lock-reason")).toBeNull()
    expect(screen.queryByTestId("key-note")).toBeNull()
  })

  it("puts a soft lock's reason under itself as a status", () => {
    setup("layout_blocks")
    const note = screen.getByTestId("lock-reason")
    expect(note.getAttribute("role")).toBe("status")
    expect(note.textContent).toBe("Needs headings from the parse step. Fast text does not find any, so it cuts by size.")
    // The stale tone, as in the approved design.
    expect(note.className).toContain("text-stale")
  })

  it("puts a hard lock's reason under itself as an alert", () => {
    setup("markdown_header")
    const note = screen.getByTestId("lock-reason")
    expect(note.getAttribute("role")).toBe("alert")
    expect(note.textContent).toMatch(/cannot run/)
    expect(note.className).toContain("text-danger")
  })

  it("says a key strategy needs a key", () => {
    setup("llm_rerank")
    const note = screen.getByTestId("key-note")
    expect(note.getAttribute("role")).toBe("status")
    expect(note.textContent).toBe("Needs an API key. Add one under Key.")
  })
})

describe("Picker, open", () => {
  it("lists each option with a tick on the pick, the name and code name, and one line of help", () => {
    const { trigger } = setup()
    openPicker(trigger())
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    const first = option(/^Recursive/)
    expect(first.getAttribute("aria-selected")).toBe("true")
    expect(first.querySelector("[data-tick] svg")).toBeTruthy()
    expect(first.textContent).toContain("recursive_character")
    expect(first.textContent).toContain("Cuts at paragraph breaks first.")
    const other = option(/^Fixed token count/)
    expect(other.getAttribute("aria-selected")).toBe("false")
    expect(other.querySelector("[data-tick] svg")).toBeNull()
  })

  it("tags a soft lock Falls back, a hard lock Cannot run, a key strategy Needs a key, and any extra tag", () => {
    const { trigger } = setup()
    openPicker(trigger())
    expect(option(/^By layout block/).textContent).toContain("Falls back")
    expect(option(/^By heading/).textContent).toContain("Cannot run")
    expect(option(/^LLM reranker/).textContent).toContain("Needs a key")
    expect(option(/^Beta/).textContent).toContain("Edited since saved")
    // The tags are read: they are part of each option's name, word by word.
    expect(option(/^By heading markdown_header Cannot run Cuts at headings\.$/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Strategy Recursive (natural breaks) recursive_character" })).toBeTruthy()
  })

  it("disables a hard-locked option: it cannot be picked", () => {
    const { trigger, onChange } = setup()
    openPicker(trigger())
    const hard = option(/^By heading/)
    expect(hard.getAttribute("aria-disabled")).toBe("true")
    expect(option(/^By layout block/).getAttribute("aria-disabled")).toBe("false")
    expect(option(/^LLM reranker/).getAttribute("aria-disabled")).toBe("false")
    fireEvent.click(hard)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("picks an option with a click, closes and gives the trigger focus", () => {
    const { trigger, onChange } = setup()
    choose(trigger(), /^Fixed token count/)
    expect(onChange).toHaveBeenCalledWith("token_based")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it("groups options under their group's name", () => {
    setup("b", [
      { value: "a", name: "Alpha", group: "Saved" },
      { value: "b", name: "Build", group: "On Build" },
    ])
    openPicker(screen.getByRole("button", { name: /^Strategy/ }))
    const saved = screen.getByRole("group", { name: "Saved" })
    expect(within(saved).getByRole("option", { name: /Alpha/ })).toBeTruthy()
    expect(within(screen.getByRole("group", { name: "On Build" })).getByRole("option", { name: /Build/ })).toBeTruthy()
  })
})

describe("Picker, keyboard", () => {
  it("opens on the pick, focused, with the pick active", () => {
    const { trigger } = setup("token_based")
    openPicker(trigger())
    expect(document.activeElement).toBe(listbox())
    expect(active()?.textContent).toContain("Fixed token count")
  })

  it("arrow keys move and skip disabled options", () => {
    const { trigger } = setup("layout_blocks")
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "ArrowDown" })
    // By heading is disabled: the move skips it.
    expect(active()?.textContent).toContain("Fixed token count")
    fireEvent.keyDown(listbox(), { key: "ArrowUp" })
    expect(active()?.textContent).toContain("By layout block")
  })

  it("Enter and Space pick the active option", () => {
    const { trigger, onChange } = setup()
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "ArrowDown" })
    fireEvent.keyDown(listbox(), { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("layout_blocks")
    expect(document.activeElement).toBe(trigger())
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "End" })
    fireEvent.keyDown(listbox(), { key: " " })
    expect(onChange).toHaveBeenLastCalledWith("beta")
  })

  it("Escape closes without picking and gives the trigger focus back", () => {
    const { trigger, onChange } = setup()
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
  })

  it("typing a letter jumps to the next name that starts with it", () => {
    const { trigger } = setup()
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "f" })
    expect(active()?.textContent).toContain("Fixed token count")
    fireEvent.keyDown(listbox(), { key: "B" })
    // By layout block, then By heading is disabled, so Beta, then round to By layout block.
    expect(active()?.textContent).toContain("Beta")
    fireEvent.keyDown(listbox(), { key: "b" })
    expect(active()?.textContent).toContain("By layout block")
  })

  it("Home and End go to the first and last option", () => {
    const { trigger } = setup("token_based")
    openPicker(trigger())
    fireEvent.keyDown(listbox(), { key: "Home" })
    expect(active()?.textContent).toContain("Recursive (natural breaks)")
    fireEvent.keyDown(listbox(), { key: "End" })
    expect(active()?.textContent).toContain("Beta")
  })

  it("ArrowDown on the closed trigger opens the list", () => {
    const { trigger } = setup()
    fireEvent.keyDown(trigger(), { key: "ArrowDown" })
    expect(listbox()).toBeTruthy()
  })

  it("does not open while disabled", () => {
    const onChange = vi.fn()
    render(
      <div>
        <span id="lbl">Strategy</span>
        <Picker id="pk" labelledBy="lbl" options={OPTIONS} value="beta" onChange={onChange} disabled />
      </div>,
    )
    const t = screen.getByRole("button", { name: /^Strategy/ }) as HTMLButtonElement
    expect(t.disabled).toBe(true)
  })
})
