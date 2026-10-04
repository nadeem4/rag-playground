import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SavedExperiment } from "@/state/experiments"

import { ExperimentMenu } from "./ExperimentMenu"

afterEach(cleanup)

const exp = (id: string, name: string, n = 7): SavedExperiment => ({
  id,
  name,
  stage: "chunk",
  recipes: Array.from({ length: n }, () => ({ transform: "recursive_character", config: {} })),
  doc: null,
  savedAt: new Date().toISOString(),
})

const props = {
  experiments: [exp("a", "Primer sizes"), exp("b", "Old one", 2)],
  usable: (e: SavedExperiment) => e.id !== "b",
  current: null,
  edited: false,
  suggestedName: "Chunk sizes on chunking-primer.pdf",
  recipeCount: 7,
  onOpen: () => {},
  onDelete: () => {},
  onSave: () => {},
  onSaveAsNew: () => {},
  onSaveChanges: () => {},
}

describe("ExperimentMenu", () => {
  it("lists the experiments with their step, count and time, and says one from another server cannot open", () => {
    render(<ExperimentMenu {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Your experiments (2)" }))
    const sheet = screen.getByRole("dialog", { name: "Your experiments" })
    expect(sheet.className).toContain("shadow-sheet")
    expect(within(sheet).getByRole("button", { name: "Primer sizes" })).toBeTruthy()
    expect(sheet.textContent).toMatch(/Chunk, seven recipes, saved today at /)
    expect(within(sheet).queryByRole("button", { name: "Old one" })).toBeNull()
    expect(sheet.textContent).toContain("Made on another server")
    expect(sheet.textContent).toContain("Experiments stay in this browser, like saved pipelines.")
  })

  it("closes a sheet on Escape and gives its button focus back", () => {
    render(<ExperimentMenu {...props} />)
    const button = screen.getByRole("button", { name: "Save experiment" })
    fireEvent.click(button)
    expect((screen.getByLabelText("Name this experiment") as HTMLInputElement).value).toBe("Chunk sizes on chunking-primer.pdf")
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it("deletes an entry and keeps focus on Your experiments", () => {
    const onDelete = vi.fn()
    render(<ExperimentMenu {...props} onDelete={onDelete} />)
    const open = screen.getByRole("button", { name: "Your experiments (2)" })
    fireEvent.click(open)
    fireEvent.click(screen.getByRole("button", { name: "Delete Primer sizes" }))
    expect(onDelete).toHaveBeenCalledWith(props.experiments[0])
    expect(document.activeElement).toBe(open)
  })

  it("says None yet when there is nothing saved", () => {
    render(<ExperimentMenu {...props} experiments={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "Your experiments" }))
    expect(screen.getByRole("dialog").textContent).toContain("None yet. Set up some recipes, then press Save experiment.")
  })
})
