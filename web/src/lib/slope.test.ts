import { describe, expect, it } from "vitest"

import { pairs, type Box } from "./slope"

const box = (left: number, top: number, width = 30, height = 30): Box => ({ left, top, width, height })

describe("the slope geometry", () => {
  it("draws a cubic from the left swatch's right centre to the right swatch's left centre, relative to the box", () => {
    const left = new Map([["a", box(110, 220)]])
    const right = new Map([["a", box(510, 120)]])
    const out = pairs(left, right, box(100, 100, 800, 600), new Map([["a", "up" as const]]))
    // Left: x 110 + 30 - 100 = 40, y 220 + 15 - 100 = 135. Right: x 510 - 100 = 410, y 120 + 15 - 100 = 35.
    expect(out).toEqual([{ id: "a", d: "M 40,135 C 80,135 370,35 410,35", kind: "up" }])
  })

  it("keeps the kind of each move and the right list's order", () => {
    const left = new Map([
      ["a", box(0, 0)],
      ["b", box(0, 40)],
      ["c", box(0, 80)],
    ])
    const right = new Map([
      ["b", box(200, 0)],
      ["a", box(200, 40)],
      ["c", box(200, 80)],
    ])
    const moves = new Map([
      ["b", "up" as const],
      ["a", "down" as const],
      ["c", "same" as const],
    ])
    const out = pairs(left, right, box(0, 0, 400, 200), moves)
    expect(out.map((p) => [p.id, p.kind])).toEqual([
      ["b", "up"],
      ["a", "down"],
      ["c", "same"],
    ])
    expect(out[2].d).toBe("M 30,95 C 70,95 160,95 200,95")
  })

  it("skips a piece without a twin, and one with no movement (a Not kept slip)", () => {
    const left = new Map([
      ["a", box(0, 0)],
      ["gone", box(0, 40)],
    ])
    const right = new Map([
      ["a", box(200, 0)],
      ["new", box(200, 40)],
      ["gone", box(200, 80)],
    ])
    const moves = new Map([
      ["a", "same" as const],
      ["new", "up" as const],
    ])
    expect(pairs(left, right, box(0, 0, 400, 200), moves).map((p) => p.id)).toEqual(["a"])
  })
})
