import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { numberWord, RUN } from "@/learn/e2e"
import { markDone, resetProgressForTests } from "@/state/lessons"

import { Home } from "./Home"

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
})
afterEach(cleanup)

const lessons = () => screen.getAllByRole("article")

describe("Home", () => {
  it("welcomes, and starts with the first lesson on a first visit", () => {
    render(<Home />)
    expect(screen.getByRole("heading", { level: 1, name: "Learn how RAG works by trying it." })).toBeTruthy()
    const go = screen.getByRole("link", { name: "Start with the first lesson" })
    expect(go.getAttribute("href")).toBe("/learn/end-to-end")
  })

  it("lists the three lessons in order, with their steps and size", () => {
    render(<Home />)
    expect(lessons().map((a) => within(a).getByRole("heading").textContent)).toEqual([
      "How RAG works, end to end",
      "Chunking",
      "How citations work",
    ])
    const first = within(lessons()[0])
    for (const s of ["Parse", "Clean", "Chunk", "Retrieve", "Rerank", "Answer", "5 steps to scroll through"]) expect(first.getByText(s)).toBeTruthy()
    expect(within(lessons()[1]).getByText("4 challenges")).toBeTruthy()
    expect(within(lessons()[2]).getByText("6 short steps")).toBeTruthy()
    expect(within(lessons()[1]).getByRole("link", { name: "Start" }).getAttribute("href")).toBe("/learn/chunking")
  })

  it("previews the first lesson with the recorded chunk map", () => {
    render(<Home />)
    const first = lessons()[0]
    expect(first.querySelectorAll("[data-chunk]")).toHaveLength(RUN.chunks.length)
    expect(first.querySelectorAll('[data-chunk="kept"], [data-chunk="top"]')).toHaveLength(RUN.mmr.length)
    expect(within(first).getByText(`The sample cut into ${RUN.chunks.length} chunks, and the ${numberWord(RUN.mmr.length)} that answered the question.`)).toBeTruthy()
  })

  it("shows Done on a finished lesson and continues with the next", () => {
    markDone("end-to-end")
    render(<Home />)
    expect(within(lessons()[0]).getByText("Done")).toBeTruthy()
    expect(within(lessons()[0]).getByRole("link", { name: "Open again" })).toBeTruthy()
    expect(within(lessons()[1]).queryByText("Done")).toBeNull()
    expect(screen.getByRole("link", { name: "Continue: Chunking" }).getAttribute("href")).toBe("/learn/chunking")
  })

  it("points your own PDF at Build and Compare", () => {
    render(<Home />)
    const own = screen.getByRole("region", { name: "Use your own PDF" })
    expect(within(own).getByRole("link", { name: "Open Build" }).getAttribute("href")).toBe("/build")
    expect(within(own).getByRole("link", { name: "Compare" }).getAttribute("href")).toBe("/compare")
  })

  it("has no em-dashes or en-dashes", () => {
    render(<Home />)
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})
