import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { continueAction, LESSONS, markDone, nextLesson, readProgress, resetProgressForTests } from "./lessons"

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
})
afterEach(() => vi.restoreAllMocks())

describe("the lesson path", () => {
  it("is end to end, then chunking, then citations, each at its own route", () => {
    expect(LESSONS.map((l) => l.href)).toEqual(["/learn/end-to-end", "/learn/chunking", "/learn/citations"])
    expect(LESSONS.map((l) => l.title)).toEqual(["How RAG works, end to end", "Chunking", "How citations work"])
  })

  it("names the next lesson after each one, and none after the last", () => {
    expect(nextLesson("end-to-end")?.slug).toBe("chunking")
    expect(nextLesson("chunking")?.slug).toBe("citations")
    expect(nextLesson("citations")).toBeNull()
  })
})

describe("progress", () => {
  it("starts empty and remembers a finished lesson under rag-lessons", () => {
    expect(readProgress()).toEqual({})
    markDone("chunking")
    expect(readProgress()).toEqual({ chunking: true })
    expect(JSON.parse(window.localStorage.getItem("rag-lessons")!)).toEqual({ chunking: true })
    resetProgressForTests()
    expect(readProgress()).toEqual({ chunking: true })
  })

  it("ignores stored junk", () => {
    window.localStorage.setItem("rag-lessons", "not json")
    expect(readProgress()).toEqual({})
  })

  it("keeps working in memory when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readProgress()).toEqual({})
    markDone("end-to-end")
    expect(readProgress()).toEqual({ "end-to-end": true })
  })
})

describe("the Continue button", () => {
  it("starts with the first lesson on a first visit", () => {
    expect(continueAction({})).toEqual({ label: "Start with the first lesson", href: "/learn/end-to-end" })
  })

  it("continues with the first lesson not done", () => {
    expect(continueAction({ "end-to-end": true })).toEqual({ label: "Continue: Chunking", href: "/learn/chunking" })
    expect(continueAction({ "end-to-end": true, chunking: true })).toEqual({ label: "Continue: How citations work", href: "/learn/citations" })
  })

  it("offers the first lesson again when every lesson is done", () => {
    expect(continueAction({ "end-to-end": true, chunking: true, citations: true })).toEqual({
      label: "Open the first lesson again",
      href: "/learn/end-to-end",
    })
  })
})
