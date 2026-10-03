import { describe, expect, it } from "vitest"

import {
  CHUNK_SLOTS,
  contrast,
  contrastMediaTokens as contrastMedia,
  contrastToggleTokens as contrastToggle,
  darkMediaTokens as darkMedia,
  darkToggleTokens as darkToggle,
  darkTokens as dark,
  inGamut,
  lightTokens as light,
  parseOklch as parse,
  resolve,
  themeTokens as theme,
  tokenCss as css,
} from "./tokenSource"

const parseOklch = (v: string) => {
  const ok = parse(v)
  if (!ok) throw new Error(`not oklch: ${v}`)
  return ok
}

const HUE_COUNT = 8
const slots = CHUNK_SLOTS

describe("categorical chunk palette (Channel B)", () => {
  it(`has ${HUE_COUNT} hues, and every fill has a paired text token`, () => {
    const fills = [...light.keys()].filter((k) => /^--chunk-\d+$/.test(k))
    expect(fills).toHaveLength(HUE_COUNT)
    for (const fill of fills) {
      expect(light.has(`${fill}-text`), `${fill}-text`).toBe(true)
      expect(darkToggle.has(fill), `dark ${fill}`).toBe(true)
      expect(darkToggle.has(`${fill}-text`), `dark ${fill}-text`).toBe(true)
    }
  })

  it.each([
    ["light", light],
    ["dark", darkToggle],
  ])("%s: fixed L and C, varying only H, with distinct hues", (_, tokens) => {
    const fills = slots.map((i) => parseOklch(tokens.get(`--chunk-${i}`)!))
    expect(new Set(fills.map((f) => f.l)).size).toBe(1)
    expect(new Set(fills.map((f) => f.c)).size).toBe(1)
    expect(new Set(fills.map((f) => f.h)).size).toBe(HUE_COUNT)
    expect(fills[0].c).toBeGreaterThanOrEqual(0.1) // dataviz chroma floor
  })

  it("the dark twin is one L-shift of the light palette", () => {
    for (const i of slots) {
      const l = parseOklch(light.get(`--chunk-${i}`)!)
      const d = parseOklch(darkToggle.get(`--chunk-${i}`)!)
      expect(d.h).toBe(l.h)
      expect(d.c).toBe(l.c)
      expect(d.l).toBeCloseTo(l.l - 0.1, 5)
    }
  })

  it.each([
    ["light", light],
    ["dark", darkToggle],
  ])("%s: every fill and paired text is in sRGB gamut and clears 4.5:1", (_, tokens) => {
    for (const i of slots) {
      const fill = tokens.get(`--chunk-${i}`)!
      const text = tokens.get(`--chunk-${i}-text`)!
      expect(inGamut(parseOklch(fill)), `chunk-${i}`).toBe(true)
      expect(inGamut(parseOklch(text)), `chunk-${i}-text`).toBe(true)
      expect(contrast(fill, text), `chunk-${i}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([
    ["light", light],
    ["dark", darkToggle],
  ])("%s: kept, removed and warn fills clear 4.5:1 with their text", (_, tokens) => {
    for (const k of ["kept", "removed", "warn"]) {
      expect(contrast(tokens.get(`--${k}`)!, tokens.get(`--${k}-text`)!), k).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([
    ["light", light, 1],
    ["dark", darkToggle, -1],
  ])("%s: the score ramp is one hue with monotone lightness", (_, tokens, direction) => {
    const ramp = [1, 2, 3, 4, 5].map((i) => parseOklch(tokens.get(`--score-${i}`)!))
    expect(new Set(ramp.map((s) => s.h)).size).toBe(1)
    for (let i = 1; i < ramp.length; i++) {
      // Light: higher score is darker. Dark: higher score is lighter.
      expect(Math.sign(ramp[i - 1].l - ramp[i].l)).toBe(direction)
    }
  })
})

describe("theme blocks", () => {
  it("the toggle and prefers-color-scheme dark blocks are identical", () => {
    expect([...darkMedia.entries()]).toEqual([...darkToggle.entries()])
  })

  it("dark overrides only names that light defines", () => {
    for (const name of darkToggle.keys()) expect(light.has(name), name).toBe(true)
  })

  it("never uses pure black or pure white", () => {
    expect(css).not.toMatch(/#(000000|000|ffffff|fff)\b/i)
    expect(css).not.toMatch(/oklch\((0|1) 0 0\)/)
  })

  it("clears Tailwind's default scales so off-contract values cannot compile", () => {
    expect(css).toMatch(/@theme \{\s*--\*: initial;/)
    const spacing = [...css.matchAll(/--spacing-(\d+): (\d+)px/g)].map((m) => +m[2])
    // 0 is the zero step (see zeroSpacing.test.ts); the scale itself caps at 32.
    expect(spacing).toEqual([0, 4, 8, 12, 16, 24, 32])
  })

  it("declares the seven type sizes in rem, so text follows the browser's font size", () => {
    const sizes = [...css.matchAll(/--text-([\w]+): ([\d.]+)rem;/g)].map((m) => [m[1], +m[2]])
    expect(sizes).toEqual([
      ["2xs", 0.75],
      ["xs", 0.8125],
      ["sm", 0.9375],
      ["base", 1.0625],
      ["lg", 1.25],
      ["xl", 1.625],
      ["2xl", 2.25],
    ])
    expect(css).not.toMatch(/--text-[\w]+: [\d.]+px/)
  })

  it("leaves the root font size to the browser", () => {
    const html = /@layer base \{\s*html \{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(html).toMatch(/font-size: 100%;/)
    expect(css).not.toMatch(/font-size: 13px/)
  })

  it("declares exactly one shadow, the raised card's", () => {
    const shadows = [...theme.keys()].filter((k) => k.startsWith("--shadow-"))
    expect(shadows).toEqual(["--shadow-raised"])
    expect(dark.get("--shadow-raised")).not.toBe(light.get("--shadow-raised"))
  })

  it("names the motion tokens once, for both themes", () => {
    expect(light.get("--dur-fast")).toBe("120ms")
    expect(light.get("--dur-mid")).toBe("200ms")
    expect(light.get("--dur-slow")).toBe("320ms")
    expect(light.get("--ease-in")).toBe("cubic-bezier(0.2, 0, 0, 1)")
    expect(light.get("--ease-out")).toBe("cubic-bezier(0.4, 0, 1, 1)")
  })

  it("sets the rows in rem, so they follow the browser size like the type", () => {
    expect(light.get("--row")).toBe("2.25rem")
    expect(light.get("--row-compact")).toBe("1.75rem")
  })
})

describe("surfaces", () => {
  it.each([
    ["light", light, ["#f7f7f5", "#efefec", "#fdfdfc"]],
    ["dark", darkToggle, ["#0e0f10", "#17181a", "#1f2023"]],
  ])("%s: page, panel and raised levels", (_, tokens, values) => {
    expect(["--surface", "--surface-elevated", "--surface-raised"].map((k) => tokens.get(k))).toEqual(values)
  })

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the field border clears 3:1 on the page and the panel", (_, tokens) => {
    for (const surface of ["--surface", "--surface-elevated"]) {
      expect(contrast(tokens.get("--field-border")!, tokens.get(surface)!), surface).toBeGreaterThanOrEqual(3)
    }
  })
})

describe("stale (Channel A)", () => {
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: stale text on its wash clears 4.5:1", (_, tokens) => {
    expect(contrast(tokens.get("--stale")!, tokens.get("--stale-wash")!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("more contrast", () => {
  it("the prefers-contrast and toggle blocks are identical", () => {
    expect([...contrastMedia.entries()]).toEqual([...contrastToggle.entries()])
  })

  it("lifts secondary text, hairlines and the raised shadow", () => {
    expect(Object.fromEntries(contrastToggle)).toEqual({
      "--text-secondary": "var(--text-primary)",
      "--hairline": "var(--field-border)",
      "--shadow-raised": "0 0 0 1px var(--field-border)",
    })
    for (const name of contrastToggle.keys()) expect(light.has(name), name).toBe(true)
  })
})

describe("the one accent (Channel A)", () => {
  it.each([
    ["light", light],
    ["dark toggle", darkToggle],
  ])("%s: the accent reads on panels, and its foreground reads on it", (_, tokens) => {
    const accent = tokens.get("--accent")!
    expect(inGamut(parse(accent)!), "accent in sRGB gamut").toBe(true)
    expect(contrast(accent, tokens.get("--surface-elevated")!), "accent on elevated").toBeGreaterThanOrEqual(4.5)
    expect(contrast(accent, tokens.get("--accent-fg")!), "accent-fg on accent").toBeGreaterThanOrEqual(4.5)
  })
})

describe("the accent hue", () => {
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: sits in the widest gap of the data hue wheel, off the indigo band", (_, tokens) => {
    const h = parse(tokens.get("--accent")!)!.h
    // Between chunk-7 (144) and chunk-4 (189), so it never reads as a chunk
    // colour, and outside 255..280, the hue band that reads as generated UI.
    expect(h).toBeGreaterThan(150)
    expect(h).toBeLessThan(185)
    expect(parse(resolve(tokens, "--selection"))!.h).toBe(h)
    expect(parse(resolve(tokens, "--accent-wash"))!.h).toBe(h)
  })
})
