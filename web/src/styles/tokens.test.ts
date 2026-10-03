/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { buildCss } from "./compileCss"

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
      ["lg", 1.375],
      ["xl", 1.75],
      ["2xl", 2.25],
    ])
    expect(css).not.toMatch(/--text-[\w]+: [\d.]+px/)
  })

  it("leaves the root font size to the browser", () => {
    const html = /@layer base \{\s*html \{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(html).toMatch(/font-size: 100%;/)
    expect(css).not.toMatch(/font-size: 13px/)
  })

  it("keeps only the first shadow layer on a phone, in both themes", () => {
    for (const tokens of [light, dark, darkMedia, darkToggle]) {
      const full = tokens.get("--shadow-raised")
      if (!full) continue
      expect(tokens.get("--shadow-raised-phone")).toBe(full.split(/,\s*(?=\d)/)[0])
    }
    expect(light.get("--shadow-raised-phone")).toBe("0 1px 2px rgb(24 24 27 / 0.06)")
    expect(dark.get("--shadow-raised-phone")).toBe("0 1px 2px rgb(0 0 0 / 0.4)")
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*:root:root:root \{\s*--shadow-raised: var\(--shadow-raised-phone\);\s*\}\s*\}/)
  })

  it("declares exactly two shadows, the raised card's and the sheet's", () => {
    const shadows = [...theme.keys()].filter((k) => k.startsWith("--shadow-"))
    expect(shadows).toEqual(["--shadow-raised", "--shadow-sheet"])
    expect(dark.get("--shadow-raised")).not.toBe(light.get("--shadow-raised"))
    expect(light.get("--shadow-sheet")).toBe("0 2px 4px rgb(22 25 23 / 0.06), 0 12px 32px rgb(22 25 23 / 0.10)")
    expect(darkToggle.get("--shadow-sheet")).toBe("0 2px 4px rgb(0 0 0 / 0.4), 0 12px 32px rgb(0 0 0 / 0.5)")
  })

  it("gives each role its radius: panel 12px, control 8px, swatch 6px", () => {
    expect(theme.get("--radius-panel")).toBe("12px")
    expect(theme.get("--radius-control")).toBe("8px")
    expect(theme.get("--radius-swatch")).toBe("6px")
  })

  it("names the motion tokens once, for both themes", () => {
    expect(light.get("--dur-fast")).toBe("120ms")
    expect(light.get("--dur-mid")).toBe("200ms")
    expect(light.get("--dur-slow")).toBe("320ms")
    expect(light.get("--dur-breathe")).toBe("1200ms")
    expect(light.get("--ease-in")).toBe("cubic-bezier(0.2, 0, 0, 1)")
    expect(light.get("--ease-out")).toBe("cubic-bezier(0.4, 0, 1, 1)")
  })

  it("breathes the running edge over --dur-breathe, and stills it under reduced motion", () => {
    expect(css).toMatch(/\.step-running-edge \{\s*animation: step-running var\(--dur-breathe\) [^;]* infinite alternate;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.step-running-edge \{\s*animation: none;\s*\}\s*\}/)
  })

  it("sets the rows in rem, so they follow the browser size like the type", () => {
    expect(light.get("--row")).toBe("2.25rem")
    expect(light.get("--row-compact")).toBe("1.75rem")
  })
})

describe("surfaces", () => {
  it.each([
    ["light", light, ["#f5f6f4", "#eaece8", "#fdfdfc"]],
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

describe("ink and lines", () => {
  it.each([
    ["light", light, ["#d6d9d3", "#838882", "#161917", "#545a55"]],
    ["dark", darkToggle, ["#2c2d31", "#71717a", "#f4f4f2", "#a8a8ae"]],
  ])("%s: hairline, field border, primary and secondary ink", (_, tokens, values) => {
    const names = ["--hairline", "--field-border", "--text-primary", "--text-secondary"]
    names.forEach((k, i) => expect(tokens.get(k), k).toBe(values[i]))
  })

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: primary and secondary text clear 4.5:1 on every surface", (_, tokens) => {
    for (const ink of ["--text-primary", "--text-secondary"]) {
      for (const surface of ["--surface", "--surface-elevated", "--surface-raised"]) {
        expect(contrast(tokens.get(ink)!, tokens.get(surface)!), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each([
    ["light", light, "#a7aca6"],
    ["dark", darkToggle, "#5a5f5b"],
  ])("%s: --flat is a line colour that stands 2:1 off the page", (_, tokens, value) => {
    expect(tokens.get("--flat")).toBe(value)
    expect(contrast(tokens.get("--flat")!, tokens.get("--surface")!)).toBeGreaterThanOrEqual(2)
    expect(theme.get("--color-flat")).toBe("var(--flat)")
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

  it("lifts secondary text, hairlines and both shadows", () => {
    expect(Object.fromEntries(contrastToggle)).toEqual({
      "--text-secondary": "var(--text-primary)",
      "--hairline": "var(--field-border)",
      "--shadow-raised": "0 0 0 1px var(--field-border)",
      "--shadow-raised-phone": "0 0 0 1px var(--field-border)",
      "--shadow-sheet": "0 0 0 1px var(--field-border)",
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

describe("faces", () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = resolvePath(here, "..")
  const fonts = readFileSync(join(here, "fonts.css"), "utf8")

  it("names the document voice and the data face", () => {
    expect(theme.get("--font-serif")).toBe('"Source Serif 4", "Iowan Old Style", Georgia, serif')
    expect(theme.get("--font-mono")).toBe('"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace')
    expect(theme.get("--font-sans")).toMatch(/^"Atkinson Hyperlegible Next"/)
  })

  it("self-hosts Source Serif 4, upright and italic, and JetBrains Mono, latin and latin-ext", () => {
    const faces = [...fonts.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1])
    const files = faces.map((f) => /files\/([\w-]+)\.woff2/.exec(f)?.[1])
    for (const file of [
      "source-serif-4-latin-wght-normal",
      "source-serif-4-latin-ext-wght-normal",
      "source-serif-4-latin-wght-italic",
      "source-serif-4-latin-ext-wght-italic",
      "jetbrains-mono-latin-wght-normal",
      "jetbrains-mono-latin-ext-wght-normal",
    ]) {
      expect(files, file).toContain(file)
    }
    for (const face of faces) expect(face).toMatch(/font-display: swap;/)
  })

  it("compiles the font-serif utility to the serif stack", async () => {
    const out = await buildCss(["font-serif", "font-mono"])
    expect(out).toMatch(/\.font-serif \{\s*font-family: var\(--font-serif\)/)
    expect(out).toMatch(/--font-serif: "Source Serif 4"/)
    expect(out).toMatch(/--font-mono: "JetBrains Mono"/)
  })

  it("leaves no trace of the old mono face under src", () => {
    const self = fileURLToPath(import.meta.url)
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
      })
    const hits = walk(src)
      .filter((path) => path !== self && /\.(tsx?|css|json)$/.test(path))
      .filter((path) => /ibm-plex|Plex|fonts-static/.test(readFileSync(path, "utf8")))
    expect(hits).toEqual([])
  })
})
