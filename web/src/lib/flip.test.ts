import { afterEach, describe, expect, it, vi } from "vitest"

import { inverse, measure, play, type Rect } from "./flip"

/** A container of rows keyed by `data-flip-key`, each with a fixed rect and a spied `animate`. */
function rows(rects: Record<string, Rect>) {
  const container = document.createElement("div")
  const animate: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const [key, r] of Object.entries(rects)) {
    const el = document.createElement("div")
    el.dataset.flipKey = key
    el.getBoundingClientRect = () => ({ ...r, width: 100, height: r.height ?? 20, right: 0, bottom: 0, x: r.left, y: r.top, toJSON: () => r }) as DOMRect
    animate[key] = vi.fn()
    ;(el as unknown as { animate: unknown }).animate = animate[key]
    container.appendChild(el)
  }
  return { container, animate }
}

const reduced = (matches: boolean) => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })))

afterEach(() => vi.unstubAllGlobals())

describe("the FLIP helper", () => {
  it("computes the inverse move from the new place back to the old one", () => {
    expect(inverse({ left: 10, top: 200 }, { left: 10, top: 40 })).toEqual({ dx: 0, dy: 160 })
    expect(inverse({ left: 0, top: 0 }, { left: 5, top: 60 })).toEqual({ dx: -5, dy: -60 })
  })

  it("measures each keyed element", () => {
    const { container } = rows({ a: { left: 0, top: 0 }, b: { left: 0, top: 30 } })
    const m = measure(container, "[data-flip-key]")
    expect([...m.keys()]).toEqual(["a", "b"])
    expect(m.get("b")!.top).toBe(30)
  })

  it("plays each moved key from its old place to identity, and skips keys that did not move or are new", () => {
    reduced(false)
    const { container, animate } = rows({ a: { left: 0, top: 0 }, b: { left: 0, top: 30 }, c: { left: 0, top: 60 } })
    const before = new Map<string, Rect>([
      ["a", { left: 0, top: 60 }],
      ["b", { left: 0, top: 30 }],
    ])
    play(container, before, { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" })
    expect(animate.a).toHaveBeenCalledTimes(1)
    expect(animate.a).toHaveBeenCalledWith([{ transform: "translate(0px, 60px)" }, { transform: "none" }], {
      duration: 320,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    })
    expect(animate.b).not.toHaveBeenCalled()
    expect(animate.c).not.toHaveBeenCalled()
  })

  it("does nothing under reduced motion: the badges carry the move", () => {
    reduced(true)
    const { container, animate } = rows({ a: { left: 0, top: 0 } })
    play(container, new Map([["a", { left: 0, top: 90 }]]), { duration: 320, easing: "linear" })
    expect(animate.a).not.toHaveBeenCalled()
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)")
  })
})
