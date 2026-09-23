/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { compile } from "tailwindcss"
import { describe, expect, it } from "vitest"

/*
 * tokens.css caps the spacing scale on purpose and declares no `--spacing`
 * multiplier, which is the enforcement. Without a `--spacing-0` the cap also
 * takes the zero step with it, and Tailwind silently drops `min-w-0`, `p-0`,
 * `inset-0` and the rest: the classes stay in the markup and do nothing.
 *
 * So compile the app's real stylesheet and check the zero utilities came out.
 * Read from disk rather than with `?raw`, because Vitest stubs every CSS file
 * that vite.config.ts does not name to the empty string.
 */

const require = createRequire(import.meta.url)
const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../index.css")

/** One per spacing-derived utility group the app actually writes. */
const ZERO = ["min-w-0", "min-h-0", "p-0", "m-0", "gap-0", "inset-0", "top-0"]

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(await readFile(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      // Relative as written; a bare `tailwindcss` means that package's index.css.
      const path = id.startsWith(".") ? resolve(base, id) : require.resolve(`${id}/index.css`)
      return { path, base: dirname(path), content: await readFile(path, "utf8") }
    },
  })
  return compiler.build(candidates)
}

describe("the zero step of the spacing scale", () => {
  it("compiles the zero utilities the app writes", async () => {
    const css = await buildCss(ZERO)
    expect(ZERO.filter((name) => !css.includes(`.${name}`))).toEqual([])
  })

  it("still refuses spacing above the 24px cap", async () => {
    const over = ["p-8", "p-32", "gap-10"]
    const css = await buildCss(over)
    expect(over.filter((name) => css.includes(`.${name}`))).toEqual([])
  })
})
