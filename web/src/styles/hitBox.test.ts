import { describe, expect, it } from "vitest"

import { buttonVariants } from "@/components/ui/button"

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
  it("gives every control a 44 px minimum size: buttons, button roles, chips, links, selects, fields and disclosures", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const sized = all.find(([, body]) => /min-height:\s*44px/.test(body) && /min-width:\s*44px/.test(body))
    expect(sized).toBeTruthy()
    expect(sized![0]).toEqual([
      "button:not(.ri-mark)",
      '[role="button"]:not(.ri-mark)',
      ".chip",
      "a",
      "select",
      'input:not([type="checkbox"]):not([type="radio"])',
      "textarea",
      "summary",
    ])
  })

  it("keeps a checkbox's drawn box and gives its label the 44 px height instead", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const label = all.find(([sel]) => sel.some((s) => s.startsWith("label:has(")))
    expect(label).toBeTruthy()
    expect(label![0].join(" ")).toContain('input[type="checkbox"]')
    expect(label![0].join(" ")).toContain('input[type="radio"]')
    expect(label![1]).toMatch(/min-height:\s*44px/)
    // The box itself is never in the sized rule, only excluded from it.
    const sized = all.find(([, body]) => /min-width:\s*44px/.test(body))!
    expect(sized[0].filter((s) => s.includes("checkbox") && !s.includes(":not("))).toEqual([])
  })

  it("covers each rank band with an overlay 24 px wide and at least 44 px tall, so its drawn size stays", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const overlay = all.find(([sel]) => sel.some((s) => s.includes(".ri-mark") && s.endsWith("::after")))
    expect(overlay).toBeTruthy()
    expect(overlay![1]).toMatch(/content:\s*""/)
    expect(overlay![1]).toMatch(/position:\s*absolute/)
    // 10 px past each side of a 4 px band: 24 px, one lane pitch on a touch screen (inspectors.css), so neighbours do not overlap.
    expect(overlay![1]).toMatch(/inset-inline:\s*-10px/)
    // 10 px past the top and the bottom, or more on a short band: never under 44 px tall.
    expect(overlay![1]).toMatch(/top:\s*min\(-10px,\s*calc\(50% - 22px\)\)/)
    expect(overlay![1]).toMatch(/bottom:\s*min\(-10px,\s*calc\(50% - 22px\)\)/)
  })

  it("keeps the 4 px rank bands out of the 44 px minimum width, so the gutter keeps its lanes", async () => {
    const all = rules(coarseBlocks(await buildCss()))
    const sized = all.find(([, body]) => /min-width:\s*44px/.test(body))!
    expect(sized[0].find((s) => s.startsWith("button"))).toContain(":not(.ri-mark)")
  })

  /** Every 44 px size declaration in the CSS, and how many sit in a coarse block. */
  const leaks = (css: string) => {
    const count = (s: string) => (s.match(/(min-)?(height|width):\s*44px/g) ?? []).length
    return { all: count(css), coarse: count(coarseBlocks(css)) }
  }

  /** Every class a Button can carry, across its variants and sizes. */
  const buttonClasses = () => {
    const out = new Set<string>()
    for (const variant of ["default", "outline", "ghost"] as const)
      for (const size of ["default", "sm", "icon"] as const) buttonVariants({ variant, size }).split(/\s+/).forEach((c) => out.add(c))
    return [...out]
  }

  it("is not applied to a fine pointer: a stylesheet that uses a Button has its 44 px only under the coarse media query", async () => {
    const css = await buildCss([...buttonClasses(), "chip", "bg-accent-wash", "border-primary"])
    expect(css).toContain(String.raw`.active\:scale-\[0\.98\]`)
    const { all, coarse } = leaks(css)
    expect(coarse).toBeGreaterThan(0)
    expect(all).toBe(coarse)
  })

  it("the leak check can fail: a 44 px utility outside the media query is caught", async () => {
    const { all, coarse } = leaks(await buildCss([...buttonClasses(), "min-h-[44px]"]))
    expect(all).toBeGreaterThan(coarse)
  })
})
