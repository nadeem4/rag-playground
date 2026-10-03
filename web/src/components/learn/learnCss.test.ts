import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(resolve(__dirname, "learn.css"), "utf8")
const rule = (selector: string) => {
  const m = css.match(new RegExp(String.raw`^${selector.replace(".", String.raw`\.`)}(?:,\n[^{]*)? \{([^}]*)\}`, "m"))
  if (!m) throw new Error(`no rule for ${selector}`)
  return m[1]
}

describe("learn.css sizes come from the type scale", () => {
  it("has no pixel or clamp() font size", () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(sizes.length).toBeGreaterThan(0)
    for (const s of sizes) expect(s).toMatch(/^var\(--text-(2xs|xs|sm|base|lg|xl|2xl)\)$/)
  })

  it("maps the display, section and lead classes onto the scale with its line heights", () => {
    expect(rule(".learn-display")).toContain("font-size: var(--text-2xl)")
    expect(rule(".learn-display")).toContain("line-height: var(--text-2xl--line-height)")
    expect(css).toMatch(/^\.learn-display,\n\.learn-title \{/m)
    expect(rule(".learn-h2")).toContain("font-size: var(--text-xl)")
    expect(rule(".learn-h2")).toContain("line-height: var(--text-xl--line-height)")
    expect(rule(".learn-lead")).toContain("font-size: var(--text-base)")
    expect(rule(".learn-lead")).toContain("line-height: var(--text-base--line-height)")
  })
})
