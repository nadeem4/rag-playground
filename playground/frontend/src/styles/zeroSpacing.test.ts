import { describe, expect, it } from "vitest"

import { buildCss } from "./compileCss"

/*
 * tokens.css caps the spacing scale on purpose and declares no `--spacing`
 * multiplier, which is the enforcement. Without a `--spacing-0` the cap also
 * takes the zero step with it, and Tailwind silently drops `min-w-0`, `p-0`,
 * `inset-0` and the rest: the classes stay in the markup and do nothing.
 *
 * So compile the app's real stylesheet and check the zero utilities came out.
 */

/** One per spacing-derived utility group the app actually writes. */
const ZERO = ["min-w-0", "min-h-0", "p-0", "m-0", "gap-0", "inset-0", "top-0"]

describe("the zero step of the spacing scale", () => {
  it("compiles the zero utilities the app writes", async () => {
    const css = await buildCss(ZERO)
    expect(ZERO.filter((name) => !css.includes(`.${name}`))).toEqual([])
  })

  it("compiles the 32px step and still refuses spacing above the 32px cap", async () => {
    const over = ["p-10", "p-12", "p-32", "gap-10"]
    const css = await buildCss(["p-8", ...over])
    expect(css).toContain(".p-8")
    expect(over.filter((name) => css.includes(`.${name}`))).toEqual([])
  })
})

describe("the two shadows", () => {
  it("compiles shadow-raised and shadow-sheet and no other shadow utility", async () => {
    const others = ["shadow", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl"]
    const css = await buildCss(["shadow-raised", "shadow-sheet", ...others])
    expect(css).toContain(".shadow-raised")
    expect(css).toMatch(/var\(--shadow-raised\)/)
    expect(css).toContain(".shadow-sheet")
    expect(css).toMatch(/var\(--shadow-sheet\)/)
    expect(others.filter((name) => css.includes(`.${name} {`))).toEqual([])
  })
})
