import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Every .ts and .tsx file under src, with tests, fixtures and the /api/v2
 * client itself left out (its paths are relative to /api/v2).
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && name !== "v2.ts" ? [path] : []
  })
}

/**
 * Old /api routes the web has moved off, as they appear in source: a path in a
 * string or a call on the old client. Task 17 adds the rest; Task 21 deletes
 * the routes.
 */
export const MOVED: RegExp[] = [
  /["'`]\/sources(?!\/sample)/,
  /["'`]\/(registry|explain|runs|sweeps|artifacts|cache|trace)\b/,
  /["'`]\/settings\/llm/,
  /\bapi\.(sources|uploadSource|deleteSource|sourceFileUrl|pages|pageImageUrl|findOnPage|questionSet|uploadQuestionSet|deleteQuestionSet|registry|explain|createRun|createSweep|run|cancelRun|eventsUrl|trace|artifact|artifactPayload|llmSettings|checkLlm|clearCache)\b/,
]

describe("the web calls pandion-api's routes", () => {
  it("names no moved /api path", () => {
    const root = join(__dirname, "..")
    const hits = sources(root).flatMap((file) => {
      const text = readFileSync(file, "utf8")
      return MOVED.filter((re) => re.test(text)).map((re) => `${file.slice(root.length + 1)}: ${re}`)
    })
    expect(hits).toEqual([])
  })
})
