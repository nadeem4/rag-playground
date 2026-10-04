import { describe, expect, it } from "vitest"

import { canonicalPath, pageFor, routeFor } from "@/App"
import { Home } from "@/routes/Home"
import { Learn } from "@/routes/Learn"
import { Lessons } from "@/routes/Lessons"
import { Read } from "@/routes/Read"
import { Shell } from "@/routes/Shell"
import { LESSONS_ENABLED } from "@/state/lessons"

describe("routes with the lessons on", () => {
  it("keeps Home at / and the lessons list at /learn", () => {
    expect(routeFor("/", true)).toBe("/")
    expect(routeFor("/learn", true)).toBe("/learn")
    expect(routeFor("/learn/chunking", true)).toBe("/learn/chunking")
    expect(routeFor("/build", true)).toBe("/build")
  })

  it("renders Home, the lessons list and the lesson pages", () => {
    expect(pageFor("/", true)).toBe(Home)
    expect(pageFor("/learn", true)).toBe(Lessons)
    expect(pageFor("/learn/chunking", true)).toBe(Learn)
    expect(pageFor("/build", true)).toBe(Shell)
    expect(pageFor("/nope", true)).toBe(Home)
  })
})

describe("routes with the lessons off", () => {
  it("renders Home at /", () => {
    expect(routeFor("/", false)).toBe("/")
    expect(pageFor("/", false)).toBe(Home)
  })

  it("sends /learn and every lesson to Home", () => {
    expect(routeFor("/learn", false)).toBe("/")
    expect(routeFor("/learn/chunking", false)).toBe("/")
    expect(routeFor("/learn/end-to-end", false)).toBe("/")
    expect(routeFor("/build", false)).toBe("/build")
    expect(routeFor("/compare", false)).toBe("/compare")
  })

  it("never renders the lessons list or a lesson", () => {
    for (const path of ["/", "/learn", "/learn/chunking", "/build", "/nope"]) {
      const page = pageFor(path, false)
      expect(page).not.toBe(Lessons)
      expect(page).not.toBe(Learn)
    }
    expect(pageFor("/build", false)).toBe(Shell)
  })

  it("falls through to Home on an unknown path", () => {
    expect(pageFor("/nope", false)).toBe(Home)
    expect(pageFor("/forms", false)).toBe(Home)
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

  it("canonicalPath maps an unknown path to /, so the address bar says Home", () => {
    expect(canonicalPath("/nope")).toBe("/")
    expect(canonicalPath("/forms")).toBe("/")
    expect(routeFor("/nope", true)).toBe("/")
    expect(canonicalPath("/build")).toBe("/build")
    expect(canonicalPath("/specimen")).toBe("/specimen")
    expect(routeFor("/learn/chunking", true)).toBe("/learn/chunking")
  })

  it("canonicalPath follows the switch", () => {
    expect(canonicalPath("/")).toBe(routeFor("/", LESSONS_ENABLED))
    expect(canonicalPath("/learn/chunking")).toBe(routeFor("/learn/chunking", LESSONS_ENABLED))
  })
})
