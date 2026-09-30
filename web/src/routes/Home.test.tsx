import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { numberWord, RUN } from "@/learn/e2e"
import { markDone, resetProgressForTests } from "@/state/lessons"

import { Home } from "./Home"

let app: unknown = { demo: false }

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
  app = { demo: false }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/settings/app" ? new Response(JSON.stringify(app), { status: 200 }) : new Response("{}", { status: 404 }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    for (const s of ["Parse", "Clean", "Chunk", "Retrieve", "Rerank", "Answer", "6 steps to scroll through"]) expect(first.getByText(s)).toBeTruthy()
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

  it("points your own PDF at Build, Compare and Evaluate", () => {
    render(<Home />)
    const own = screen.getByRole("region", { name: "Use your own PDF" })
    expect(within(own).getByRole("link", { name: "Open Build" }).getAttribute("href")).toBe("/build")
    expect(within(own).getByRole("link", { name: "Compare" }).getAttribute("href")).toBe("/compare")
    expect(within(own).getByRole("link", { name: "Evaluate" }).getAttribute("href")).toBe("/evaluate")
    expect(within(own).getByText(/Evaluate scores a pipeline against a sample's questions\./)).toBeTruthy()
  })

  it("states the upload limits on the demo, and that only a written answer needs a key", async () => {
    app = { demo: true, limits: { max_bytes: 10 * 1048576, max_pages: 20, max_files: 5, max_total_bytes: 50 * 1048576, ttl_hours: 24 } }
    render(<Home />)
    await waitFor(() =>
      expect(screen.getByTestId("own-pdf-note").textContent).toBe(
        "Your own PDF can be up to 10 MB and 20 pages. Everything works without a key, except a written answer.",
      ),
    )
  })

  it("says only that a written answer needs a key when running locally", async () => {
    render(<Home />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === "/api/settings/app")).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId("own-pdf-note").textContent).toBe("Everything works without a key, except a written answer.")
  })

  it("has no em-dashes or en-dashes", () => {
    render(<Home />)
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})

describe("Home footer", () => {
  it("names the author, so the page has a person behind it", () => {
    render(<Home />)
    const footer = screen.getByRole("contentinfo")
    expect(within(footer).getByText(/Made by/)).toBeTruthy()
    expect(within(footer).getByRole("link", { name: "Nadeem Khan" }).getAttribute("href")).toBe("https://github.com/nadeem4")
  })
})
