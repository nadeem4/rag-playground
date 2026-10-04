import { afterEach, describe, expect, it, vi } from "vitest"

import { drawSlope, pairs, type Box } from "./slope"

const box = (left: number, top: number, width = 30, height = 30): Box => ({ left, top, width, height })

/** The 64 px gutter, from x 200 to x 264 of the page. */
const GUTTER = box(200, 0, 64, 600)

describe("the slope geometry", () => {
  it("runs inside the gutter, from its left edge plus 2 px to its right edge minus 2 px, at each swatch's centre", () => {
    const left = new Map([["a", box(110, 220)]])
    const right = new Map([["a", box(510, 120)]])
    const out = pairs(left, right, box(100, 100, 800, 600), GUTTER, new Map([["a", "up" as const]]))
    // x1 = 200 - 100 + 2 = 102, y1 = 220 + 15 - 100 = 135. x2 = 264 - 100 - 2 = 162, y2 = 120 + 15 - 100 = 35.
    expect(out).toEqual([{ id: "a", d: "M 102,135 C 142,135 122,35 162,35", kind: "up" }])
  })

  it("keeps the kind of each move and the right list's order", () => {
    const left = new Map([
      ["a", box(0, 0)],
      ["b", box(0, 40)],
      ["c", box(0, 80)],
    ])
    const right = new Map([
      ["b", box(300, 0)],
      ["a", box(300, 40)],
      ["c", box(300, 80)],
    ])
    const moves = new Map([
      ["b", "up" as const],
      ["a", "down" as const],
      ["c", "same" as const],
    ])
    const out = pairs(left, right, box(0, 0, 400, 200), GUTTER, moves)
    expect(out.map((p) => [p.id, p.kind])).toEqual([
      ["b", "up"],
      ["a", "down"],
      ["c", "same"],
    ])
    expect(out[2].d).toBe("M 202,95 C 242,95 222,95 262,95")
  })

  it("skips a piece without a twin, and one with no movement (a Not kept slip)", () => {
    const left = new Map([
      ["a", box(0, 0)],
      ["gone", box(0, 40)],
    ])
    const right = new Map([
      ["a", box(300, 0)],
      ["new", box(300, 40)],
      ["gone", box(300, 80)],
    ])
    const moves = new Map([
      ["a", "same" as const],
      ["new", "up" as const],
    ])
    expect(pairs(left, right, box(0, 0, 400, 200), GUTTER, moves).map((p) => p.id)).toEqual(["a"])
  })
})

describe("the draw", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** An overlay of paths, each with a fixed length and a spied `animate`. */
  function overlay(lengths: number[]) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    const animate = lengths.map((len) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
      const spy = vi.fn()
      Object.assign(p, { getTotalLength: () => len, animate: spy })
      svg.appendChild(p)
      return spy
    })
    return { svg, animate }
  }

  it("draws each line from nothing to its full length, with a dash as long as the line", () => {
    const { svg, animate } = overlay([120, 80])
    drawSlope(svg, { duration: 360, easing: "ease" })
    expect(animate[0]).toHaveBeenCalledWith(
      [
        { strokeDasharray: "120", strokeDashoffset: 120 },
        { strokeDasharray: "120", strokeDashoffset: 0 },
      ],
      { duration: 360, easing: "ease" },
    )
    expect(animate[1].mock.calls[0][0][0]).toEqual({ strokeDasharray: "80", strokeDashoffset: 80 })
  })

  it("does nothing under reduced motion: the lines are there at full length", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    const { svg, animate } = overlay([120])
    drawSlope(svg, { duration: 360, easing: "ease" })
    expect(animate[0]).not.toHaveBeenCalled()
  })
})
