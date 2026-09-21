/**
 * Read tokens.css as data, for the specimen page and the token tests.
 *
 * The page itself is locked to one theme at a time (Page Theme Lock), so the
 * specimen cannot show the other theme by flipping a sub-tree. Instead it
 * reads both themes' values straight from the source file and renders them as
 * swatches, while the live chrome stays in the current theme.
 */

import css from "./tokens.css?raw"

export type TokenMap = Map<string, string>

/** Declarations of the first rule matching `selector`, as name -> value. */
export function readBlock(source: string, selector: RegExp): TokenMap {
  const match = selector.exec(source)
  if (!match) throw new Error(`tokens.css: no block for ${selector}`)
  const start = source.indexOf("{", match.index + match[0].length - 1) + 1
  const end = source.indexOf("}", start)
  const out: TokenMap = new Map()
  for (const [, name, value] of source.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.trim())
  }
  return out
}

export const tokenCss: string = css
export const lightTokens = readBlock(css, /^:root \{/m)
const darkOverrides = readBlock(css, /^:root\[data-theme="dark"\] \{/m)
export const darkMediaTokens = readBlock(css, /:root:not\(\[data-theme="light"\]\) \{/)
export const darkToggleTokens = darkOverrides
/** Dark values, with light values for anything dark does not override. */
export const darkTokens: TokenMap = new Map([...lightTokens, ...darkOverrides])

/** Resolve `var(--x)` chains against one theme's map. */
export function resolve(tokens: TokenMap, name: string): string {
  let value = tokens.get(name) ?? ""
  for (let i = 0; i < 8; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)
    if (!ref) break
    value = tokens.get(ref[1]) ?? ""
  }
  return value
}

// ------------------------------------------------------------ color math --

export interface Oklch {
  l: number
  c: number
  h: number
}

export function parseOklch(value: string): Oklch | null {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value)
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null
}

/** OKLCH -> linear sRGB (Ottosson's matrices). */
export function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

export const inGamut = (x: Oklch) => oklchToLinearRgb(x).every((v) => v > -0.001 && v < 1.001)

function hexToLinearRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [0, 2, 4].map((i) => {
    const s = parseInt(h.slice(i, i + 2), 16) / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
}

/** WCAG relative luminance of an `oklch(...)` or `#rrggbb` token value. */
export function luminance(value: string): number {
  const ok = parseOklch(value)
  const rgb = ok ? oklchToLinearRgb(ok) : hexToLinearRgb(value)
  const [r, g, b] = rgb.map((v) => Math.min(1, Math.max(0, v)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two token values. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const CHUNK_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const
export const SCORE_STEPS = [1, 2, 3, 4, 5] as const
