import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { Trace, TraceStep } from "@/api/types"

import { MissTrace } from "./MissTrace"

afterEach(cleanup)

const skip = (stage: TraceStep["stage"], name: string): TraceStep => ({
  stage,
  name,
  status: "not_checked",
  sentence: "Not checked.",
  evidence: null,
})

const BROKEN: Trace = {
  finding: "Lost at Parse. Fast text put other text in the middle of the answer sentence, so no later step can find it.",
  lost_at: "parse",
  fix: "Use a parser that reads the page layout, such as Docling, then evaluate again.",
  golds: ["the number of readers who lost their place halfway down a page fell by more than half"],
  steps: [
    {
      stage: "parse",
      name: "Parse",
      status: "lost",
      sentence: "The answer's words are here, in order, with other text between them.",
      evidence: {
        kind: "broken",
        parts: [
          { kind: "context", text: "A reader who has to" },
          { kind: "answer", text: "the number of readers who lost their place" },
          { kind: "other", text: "hunt for the next line has already stopped" },
          { kind: "answer", text: "halfway down a page fell by more than half." },
        ],
      },
    },
    skip("clean", "Clean"),
    skip("chunk", "Chunk"),
    skip("search", "Search"),
    skip("top_k", "Top 5"),
  ],
}

const FOUND: Trace = {
  finding: "Found. The answer came through every step.",
  lost_at: null,
  fix: null,
  golds: ["The survey ran for six weeks."],
  steps: [
    { stage: "parse", name: "Parse", status: "pass", sentence: "The answer sentence is in the parsed text.", evidence: null },
    { stage: "chunk", name: "Chunk", status: "pass", sentence: "Whole inside piece 1 of 6.", evidence: null },
    { stage: "search", name: "Search", status: "pass", sentence: "Piece 1 came back 1st of 6.", evidence: null },
    { stage: "top_k", name: "Top 5", status: "pass", sentence: "1st, inside the 5 pieces checked.", evidence: null },
  ],
}

describe("MissTrace", () => {
  it("leads with the finding, then every step with its status", () => {
    render(<MissTrace trace={BROKEN} fixHref="/build?step=parse" />)
    expect(screen.getByText(/^Lost at Parse\./)).toBeTruthy()
    const steps = screen.getAllByRole("listitem")
    expect(steps.map((li) => li.getAttribute("data-status"))).toEqual(["lost", "not_checked", "not_checked", "not_checked", "not_checked"])
    expect(within(steps[0]).getByText("Lost here")).toBeTruthy()
    expect(within(steps[1]).getByText("Not checked.")).toBeTruthy()
  })

  it("marks the answer's words and strikes the words that broke into it", () => {
    render(<MissTrace trace={BROKEN} fixHref={null} />)
    const answers = document.querySelectorAll("[data-part='answer']")
    const others = document.querySelectorAll("[data-part='other']")
    expect([...answers].map((e) => e.textContent)).toEqual([
      "the number of readers who lost their place",
      "halfway down a page fell by more than half.",
    ])
    expect(others).toHaveLength(1)
    expect(others[0].tagName).toBe("DEL")
    expect(screen.getByText(BROKEN.golds[0], { exact: false })).toBeTruthy()
  })

  it("suggests a fix and links to the step on Build", () => {
    render(<MissTrace trace={BROKEN} fixHref="/build?step=parse" />)
    expect(screen.getByText(BROKEN.fix!)).toBeTruthy()
    const link = screen.getByRole("link", { name: "Change Parse on Build" })
    expect(link.getAttribute("href")).toBe("/build?step=parse")
  })

  it("shows a hit's steps all passed, with no fix", () => {
    render(<MissTrace trace={FOUND} fixHref={null} />)
    expect(document.querySelector("[data-trace] p")?.textContent).toBe("Found. The answer came through every step.")
    expect(screen.getAllByRole("listitem").every((li) => li.getAttribute("data-status") === "pass")).toBe(true)
    expect(screen.queryByText("Try a fix")).toBeNull()
  })
})
