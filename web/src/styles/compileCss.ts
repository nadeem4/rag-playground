/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { compile } from "tailwindcss"

/*
 * Compiles the app's real stylesheet (index.css and what it imports) with the
 * given utility candidates, for tests that check what the CSS actually says.
 * Read from disk rather than with `?raw`, because Vitest stubs every CSS file
 * that vite.config.ts does not name to the empty string. Tests only.
 */

const require = createRequire(import.meta.url)
const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../index.css")

export async function buildCss(candidates: string[] = []): Promise<string> {
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
