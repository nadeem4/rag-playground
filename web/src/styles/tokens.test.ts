import { describe, expect, it } from "vitest"

import {
  CHUNK_SLOTS,
  contrast,
  darkMediaTokens as darkMedia,
  darkToggleTokens as darkToggle,
  inGamut,
  lightTokens as light,
  parseOklch as parse,
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
    expect(spacing).toEqual([4, 8, 12, 16, 24])
    const sizes = [...css.matchAll(/--text-(2xs|xs|sm|base|lg|xl): (\d+)px/g)].map((m) => +m[2])
    expect(sizes).toEqual([11, 12, 13, 14, 16, 20])
  })
})
