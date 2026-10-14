import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/** Every .tsx under src, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith(".tsx") && !path.includes(".test.") ? [path] : []
  })
}

describe("bar heights follow the type", () => {
  it("no bar sets a pixel minimum height of 40px: bars use min-h-row, in rem", () => {
    const offenders = sources(join(__dirname, "..")).filter((path) => readFileSync(path, "utf8").includes("min-h-[40px]"))
    expect(offenders).toEqual([])
  })
})
