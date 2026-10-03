import { describe, expect, it } from "vitest"

import { buildCss } from "./compileCss"

/*
 * jsdom does not apply CSS, so a matchMedia stub cannot show the hit box.
 * Instead compile the real stylesheet and read the coarse-pointer rules out
 * of it: what the browser would apply on a touch screen.
 */

/** The body of every `@media (pointer: coarse)` block in the compiled CSS. */
function coarseBlocks(css: string): string {
  const out: string[] = []
  const re = /@media \(pointer: coarse\)\s*\{/g
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++
      else if (css[i] === "}") depth--
      i++
    }
    out.push(css.slice(start, i - 1))
  }
  return out.join("\n")
}

/** Each rule in a block as [selector list, declarations]. */
function rules(block: string): [string[], string][] {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].split(",").map((s) => s.trim()), m[2]])
}

describe("the 44 px hit box on a coarse pointer", () => {
  it("gives buttons, button roles and chips a 44 px minimum size", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const sized = all.find(([, body]) => /min-height:\s*44px/.test(body) && /min-width:\s*44px/.test(body))
    expect(sized).toBeTruthy()
    const selectors = sized![0].join(" ")
    expect(selectors).toMatch(/(^|\s)button\b/)
    expect(selectors).toContain('[role="button"]')
    expect(selectors).toContain(".chip")
  })

  it("covers the small rank marks with an overlay 10 px past every edge, so their drawn size stays", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const overlay = all.find(([sel]) => sel.some((s) => s.includes(".ri-mark") && s.endsWith("::after")))
    expect(overlay).toBeTruthy()
    expect(overlay![1]).toMatch(/position:\s*absolute/)
    expect(overlay![1]).toMatch(/inset:\s*-10px/)
    expect(overlay![1]).toMatch(/content:\s*""/)
  })

  it("keeps the 4 px rank bands out of the 44 px minimum width, so the gutter keeps its lanes", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const sized = all.find(([, body]) => /min-width:\s*44px/.test(body))!
    expect(sized[0].find((s) => s.startsWith("button"))).toContain(":not(.ri-mark)")
  })

  it("is not applied to a fine pointer: the rules live only under the coarse media query", async () => {
    const css = await buildCss()
    const count = (s: string) => (s.match(/min-height:\s*44px/g) ?? []).length
    expect(count(css)).toBeGreaterThan(0)
    expect(count(css)).toBe(count(coarseBlocks(css)))
  })
})
