import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Cost } from "@/api/types"
import { costValues } from "@/state/cost"

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

  it("says one piece, not one pieces, in the narrow list", () => {
    const row = (i: number, pieces: number): OverviewRow => ({ i, name: `R${i}`, code: "token_based", own: i === 0, status: { kind: "done" }, seconds: null, done: true, values: { pieces, tokens: 9, median: 9, p95: 9, uncovered: 0 } })
    render(<Overview {...props} stage="chunk" goldKnown={false} narrow rows={[row(0, 1), row(1, 3), row(2, 2), row(3, 2)]} />)
    expect(screen.getByRole("list").textContent).toMatch(/1 piece \(fewest\), 9 tokens/)
  })

  it("marks the recipes the server names best, in the table and in the narrow list", () => {
    const rows = props.rows.map((r) => ({ ...r, best: r.i === 1 }))
    const { rerender } = render(<Overview {...props} rows={rows} />)
    const row = (i: number) => document.querySelector<HTMLElement>(`[data-recipe="${i}"]`)!
    expect(within(row(1)).getByText("Best")).toBeTruthy()
    expect(within(row(0)).queryByText("Best")).toBeNull()
    rerender(<Overview {...props} rows={rows} narrow />)
    expect(within(row(1)).getByText("Best")).toBeTruthy()
    expect(screen.getAllByText("Best")).toHaveLength(1)
  })

  describe("time, tokens and cost", () => {
    const cost = (over: Partial<Cost>): Cost => ({
      seconds: 1,
      input_tokens: null,
      output_tokens: null,
      dollars: null,
      unpriced_models: [],
      uncounted_models: [],
      steps_run: 1,
      steps_cached: 0,
      prices_as_of: "2026-10-15",
      ...over,
    })
    const costs = [
      cost({ seconds: 0.05 }),
      cost({ seconds: 2.71, input_tokens: 4120, output_tokens: 96, dollars: 0.0046 }),
      cost({ seconds: 3.8, input_tokens: 4300, output_tokens: 110, unpriced_models: ["openrouter/meta-llama-3.3-70b"] }),
      cost({ seconds: 5.41, uncounted_models: ["claude-sonnet-5"] }),
    ]
    const rows = props.rows.map((r, i) => ({ ...r, done: true, status: { kind: "done" as const }, cost: costs[i], values: { ...r.values, ...costValues(costs[i]) } }))
    const row = (i: number) => document.querySelector<HTMLElement>(`[data-recipe="${i}"]`)!

    it("adds Time, Tokens and Cost after the existing columns, from each recipe's varied cost", () => {
      render(<Overview {...props} rows={rows} variedFrom="rerank" />)
      const table = screen.getByRole("table")
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Select", "Recipe", "Answer", "Shared", "Returned", "Top 5, by piece", "Time, rerank and after", "Tokens", "Cost"])
      expect(within(row(0)).getByText("0.05 s")).toBeTruthy()
      expect(within(row(1)).getByText("2.7 s")).toBeTruthy()
      expect(within(row(1)).getByText("4,120")).toBeTruthy()
      expect(within(row(1)).getByText("in, 96 out")).toBeTruthy()
      expect(within(row(1)).getByText("$0.0046")).toBeTruthy()
      // No model counted tokens: a dash, never 0; nothing paid: local, never $0.
      expect(within(row(0)).getByLabelText("No tokens").textContent).toBe("-")
      expect(within(row(0)).getByText("local")).toBeTruthy()
      expect(row(0).textContent).not.toMatch(/\$0(?!\.)/)
      const noPrice = within(row(2)).getByText("no price")
      expect(noPrice.getAttribute("title")).toBe("openrouter/meta-llama-3.3-70b has no entry in the price table")
      expect(noPrice.className).toContain("bg-warn")
      expect(within(row(3)).getByText("no token count")).toBeTruthy()
      expect(row(3).textContent).not.toContain("$")
    })

    it("sorts each new column, the unknowns last", () => {
      const onSort = vi.fn()
      const { rerender } = render(<Overview {...props} rows={rows} variedFrom="rerank" onSort={onSort} />)
      fireEvent.click(screen.getByRole("button", { name: "Time, rerank and after" }))
      expect(onSort).toHaveBeenLastCalledWith("time", 1)
      fireEvent.click(screen.getByRole("button", { name: "Cost" }))
      expect(onSort).toHaveBeenLastCalledWith("cost", 1)
      const order = () => Array.from(document.querySelectorAll("[data-recipe]")).map((r) => r.getAttribute("data-recipe"))
      rerender(<Overview {...props} rows={rows} variedFrom="rerank" sort={{ key: "time", dir: -1 }} />)
      expect(order()).toEqual(["3", "2", "1", "0"])
      rerender(<Overview {...props} rows={rows} variedFrom="rerank" sort={{ key: "cost", dir: 1 }} />)
      expect(order()).toEqual(["0", "1", "2", "3"])
      rerender(<Overview {...props} rows={rows} variedFrom="rerank" sort={{ key: "cost", dir: -1 }} />)
      expect(order()).toEqual(["1", "0", "2", "3"])
      rerender(<Overview {...props} rows={rows} variedFrom="rerank" sort={{ key: "modelTokens", dir: -1 }} />)
      expect(order()).toEqual(["2", "1", "0", "3"])
    })

    it("offers the new columns in Sort by and says the three values on a phone", () => {
      render(<Overview {...props} rows={rows} variedFrom="rerank" narrow />)
      const options = Array.from(screen.getByLabelText<HTMLSelectElement>("Sort by").options).map((o) => o.textContent)
      expect(options.slice(-3)).toEqual(["Time", "Tokens", "Cost"])
      expect(within(row(1)).getByText("2.7 s · 4,120 in / 96 out · $0.0046")).toBeTruthy()
    })

    it("calls the model's tokens Model tokens on Chunk, beside the pieces' own Tokens", () => {
      const chunkRows = rows.map((r) => ({ ...r, values: { ...r.values, pieces: 3, tokens: 9, median: 9, p95: 9, uncovered: 0 } }))
      render(<Overview {...props} stage="chunk" goldKnown={false} rows={chunkRows} variedFrom="chunk" />)
      const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)
      expect(heads.slice(-3)).toEqual(["Time, chunk and after", "Model tokens", "Cost"])
    })

    it("shows none of it for an older result with no varied cost", () => {
      render(<Overview {...props} variedFrom={null} />)
      expect(screen.queryByText(/^Time/)).toBeNull()
      render(<Overview {...props} narrow />)
      expect(Array.from(screen.getByLabelText<HTMLSelectElement>("Sort by").options).map((o) => o.textContent)).not.toContain("Cost")
    })
  })
})
