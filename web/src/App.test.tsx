import { describe, expect, it } from "vitest"

import { canonicalPath, pageFor, routeFor } from "@/App"
import { Home } from "@/routes/Home"
import { Learn } from "@/routes/Learn"
import { Read } from "@/routes/Read"
import { Shell } from "@/routes/Shell"
import { LESSONS_ENABLED } from "@/state/lessons"

describe("routeFor with the lessons on", () => {
  it("keeps Home at / and sends /learn to Home", () => {
    expect(routeFor("/", true)).toBe("/")
    expect(routeFor("/learn", true)).toBe("/")
    expect(routeFor("/learn/chunking", true)).toBe("/learn/chunking")
    expect(routeFor("/build", true)).toBe("/build")
  })

  it("renders Home and the lesson pages", () => {
    expect(pageFor("/", true)).toBe(Home)
    expect(pageFor("/learn/chunking", true)).toBe(Learn)
    expect(pageFor("/build", true)).toBe(Shell)
    expect(pageFor("/nope", true)).toBe(Home)
  })
})

describe("routeFor with the lessons off", () => {
  it("sends /, /learn and every lesson to /build", () => {
    expect(routeFor("/", false)).toBe("/build")
    expect(routeFor("/learn", false)).toBe("/build")
    expect(routeFor("/learn/chunking", false)).toBe("/build")
    expect(routeFor("/learn/end-to-end", false)).toBe("/build")
    expect(routeFor("/build", false)).toBe("/build")
    expect(routeFor("/compare", false)).toBe("/compare")
  })

  it("never renders Home or Learn", () => {
    for (const path of ["/", "/learn", "/learn/chunking", "/build", "/nope"]) {
      const page = pageFor(path, false)
      expect(page).not.toBe(Home)
      expect(page).not.toBe(Learn)
    }
    expect(pageFor("/build", false)).toBe(Shell)
    expect(pageFor("/nope", false)).toBe(Shell)
  })

  it("renders the Read page at /read", () => {
    expect(routeFor("/read", false)).toBe("/read")
    expect(pageFor("/read", false)).toBe(Read)
    expect(pageFor("/read", true)).toBe(Read)
  })
})

describe("the switch", () => {
  it("hides the lessons on the demo for now", () => {
    expect(LESSONS_ENABLED).toBe(false)
  })

  it("canonicalPath follows the switch", () => {
    expect(canonicalPath("/")).toBe(routeFor("/", LESSONS_ENABLED))
    expect(canonicalPath("/learn/chunking")).toBe(routeFor("/learn/chunking", LESSONS_ENABLED))
  })
})
