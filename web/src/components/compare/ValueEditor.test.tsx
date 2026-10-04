import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ValueEditor, type StrategyChoice } from "./ValueEditor"

afterEach(cleanup)

const STRATEGIES: StrategyChoice[] = [
  { name: "recursive_character", plain: "Recursive (natural breaks)", gloss: "Cuts at paragraph breaks first." },
  { name: "layout_blocks", plain: "By layout block", gloss: "Cuts along the page's blocks.", lock: { kind: "soft", reason: "It cuts by size." } },
  { name: "markdown_header", plain: "By heading", gloss: "Cuts at headings.", lock: { kind: "hard", reason: "It cannot run." } },
]

function setup() {
  const onPick = vi.fn()
  render(
    <ValueEditor
      field="transform"
      schema={{ type: "object", properties: {} }}
      config={{}}
      onChange={vi.fn()}
      transform="recursive_character"
      strategies={STRATEGIES}
      onPick={onPick}
      onClose={vi.fn()}
    />,
  )
  return { onPick }
}

describe("the strategy editor", () => {
  it("tags a strategy that falls back and one that cannot run, and the second cannot be picked", () => {
    const { onPick } = setup()
    const soft = screen.getByRole("button", { name: /^By layout block layout_blocks Falls back/ }) as HTMLButtonElement
    expect(soft.disabled).toBe(false)
    const hard = screen.getByRole("button", { name: /^By heading markdown_header Cannot run/ }) as HTMLButtonElement
    expect(hard.disabled).toBe(true)
    fireEvent.click(hard)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(soft)
    expect(onPick).toHaveBeenCalledWith("layout_blocks")
  })
})
