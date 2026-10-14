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
 * string (relative to the old client's base, written in full as `/api/...`, or
 * after `${API_BASE}`) or a call on the old client. Task 21 deletes the routes.
 */
export const MOVED: RegExp[] = [
  /(?:["'`]|\$\{API_BASE\})(?:\/api)?\/(?:sources(?!\/sample)|registry|explain|runs|sweeps|artifacts|cache|trace|settings\/llm)\b/,
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

  const flagged = (text: string) => MOVED.some((re) => re.test(text))

  it("flags an old route written as a full path, by hand or on a base", () => {
    for (const text of [
      'fetch("/api/runs")',
      'fetch("/api/explain", x)',
      "new EventSource(`/api/runs/${id}/events`)",
      "request(`${API_BASE}/cache`)",
      '<img src="/api/sources/x/pages/1.png">',
      'fetch("/api/settings/llm/check")',
      "api.createRun(body)",
    ])
      expect(flagged(text), text).toBe(true)
  })

  it("lets /api/v2 and the kept teaching routes through", () => {
    for (const text of [
      'fetch("/api/v2/runs")',
      "`/api/v2/documents/${sha}/pages/1?scale=2`",
      'request("/sources/sample")',
      'fetch("/api/sources/sample")',
      'fetch("/api/samples")',
      'fetch("/api/learn/chunking")',
      'fetch("/api/stages")',
      'fetch("/api/settings/app")',
      'fetch("/api/questions/template?format=csv")',
      'fetch("/api/health")',
      "api.samples()",
    ])
      expect(flagged(text), text).toBe(false)
  })
})
