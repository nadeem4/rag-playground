import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Overview, type OverviewRow } from "./Overview"

afterEach(cleanup)

const search = (i: number, rank: number | null, shared: number | null, done = true): OverviewRow => ({
  i,
  name: ["Hybrid (RRF)", "Dense", "BM25", "Dense, top 1"][i],
  code: "dense",
  own: i === 0,
  status: done ? { kind: "done" } : { kind: "waiting" },
  seconds: null,
  done,
  values: { rank, shared, returned: 5 },
  pieces: [
    { piece: 1, slot: 1, answer: rank === 1 },
    { piece: 8, slot: 8, answer: false },
  ],
})

const props = {
  stage: "retrieve" as const,
  rows: [search(0, 1, null), search(1, 2, 4), search(2, null, 3), search(3, null, null, false)],
  sort: { key: "order" as const, dir: 1 as const },
  onSort: () => {},
  ticked: [],
  onTick: () => {},
  onClear: () => {},
  onRead: () => {},
  onOpen: () => {},
  onChange: () => {},
  fit: 3,
  narrow: false,
  goldKnown: true,
  top: 5,
}

describe("Overview", () => {
  it("shows the Answer column when the answer is known, with none and not found where it is missing", () => {
    render(<Overview {...props} />)
    const table = screen.getByRole("table", { name: "Results for four recipes" })
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Select", "Recipe", "Answer", "Shared", "Returned", "Top 5, by piece"])
    expect(within(table).getByText("baseline")).toBeTruthy()
    expect(within(table).getByText("4 of 5")).toBeTruthy()
    expect(within(table).getAllByText("not found")).toHaveLength(1)
    expect(screen.getAllByRole("img", { name: "Top 2: piece 1 (the answer), piece 8" })).toHaveLength(1)
  })

  it("sorts Answer from the best rank first, and flips on a second press", () => {
    const onSort = vi.fn()
    const { rerender } = render(<Overview {...props} onSort={onSort} />)
    fireEvent.click(screen.getByRole("button", { name: "Answer" }))
    expect(onSort).toHaveBeenLastCalledWith("rank", 1)
    rerender(<Overview {...props} onSort={onSort} sort={{ key: "rank", dir: 1 }} />)
    expect(screen.getByRole("button", { name: "Answer" }).closest("th")!.getAttribute("aria-sort")).toBe("ascending")
    fireEvent.click(screen.getByRole("button", { name: "Answer" }))
    expect(onSort).toHaveBeenLastCalledWith("rank", -1)
  })

  it("gives an unfinished row no open button and no tick, only its status", () => {
    render(<Overview {...props} />)
    const row = document.querySelector<HTMLElement>('[data-recipe="3"]')!
    expect(within(row).queryByRole("button")).toBeNull()
    expect(within(row).queryByRole("checkbox")).toBeNull()
    expect(within(row).getByTestId("recipe-status").textContent).toMatch(/^Waiting/)
    expect(screen.getByRole("button", { name: "Open Your pipeline" })).toBeTruthy()
  })

  it("gives the ticks, the sort buttons and the names a 44 px box under a coarse pointer", () => {
    render(<Overview {...props} />)
    expect(screen.getByRole("checkbox", { name: "Select Dense" }).closest("label")!.className).toContain("pointer-coarse:min-h-[44px]")
    expect(screen.getByRole("button", { name: "Answer" }).className).toContain("pointer-coarse:min-h-[44px]")
    expect(screen.getByRole("button", { name: "Open Dense beside Your pipeline" }).className).toContain("pointer-coarse:min-h-[44px]")
  })
})
