import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"
import { readProgress, resetProgressForTests } from "@/state/lessons"

import { LessonShell, type LessonStep } from "./LessonShell"

const SHA = "cd".repeat(32)
const SENTENCE = "A retriever scores each chunk as a whole."
const TEXT = `## Chunking\n\n${SENTENCE} The model then gets a passage.`
const DOC = { filename: "chunking-primer.pdf", page_count: 3, text: TEXT }

beforeEach(() => {
  window.localStorage.clear()
  resetProgressForTests()
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/learn/document") return ok(DOC)
      if (url === `/api/sources/${SHA}/pages`) return ok([1, 2, 3].map((n) => ({ n, width: 612, height: 792 })))
      if (url.startsWith(`/api/sources/${SHA}/pages/1/find`)) return ok({ rects: [[72, 600, 540, 612]], matched: "exact" })
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const STEPS: LessonStep[] = [
  { id: "idea", title: "Read the idea", sentence: SENTENCE, body: <p>Chunks are pieces of the document.</p> },
  { id: "predict", title: "Predict", body: <p>Will the sentence stay whole?</p> },
  { id: "see", title: "See the result", body: <p>It was cut in two.</p> },
]

const RECAP = ["A document is cut into chunks.", "The size decides what stays whole."]

function Harness({ steps = STEPS }: { steps?: LessonStep[] }) {
  const [step, setStep] = useState(0)
  return <LessonShell title="Chunking" slug="chunking" sha={SHA} steps={steps} step={step} onStep={setStep} recap={RECAP} />
}

const rail = () => screen.getByRole("navigation", { name: "Steps" })
const railSteps = () => within(rail()).getAllByRole("button")
const main = () => screen.getByRole("region", { name: "The step" })
const doc = () => screen.getByRole("region", { name: "The document" })
const shell = () => document.querySelector("[data-pane]") as HTMLElement

describe("The lesson shell", () => {
  it("lists every step plus a recap, and opens on the first", () => {
    render(<Harness />)
    expect(screen.getByRole("heading", { level: 1, name: "Chunking" })).toBeTruthy()
    expect(railSteps().map((b) => b.textContent)).toEqual(["1Read the idea", "2Predict", "3See the result", "4Recap"])
    expect(railSteps()[0].getAttribute("aria-current")).toBe("step")
    expect(within(main()).getByRole("heading", { level: 2, name: "Read the idea" })).toBeTruthy()
    expect(within(main()).getByText("Step 1 of 4")).toBeTruthy()
    expect(within(main()).queryByText("It was cut in two.")).toBeNull()
  })

  it("moves with Next and Back, and jumps from the step list", () => {
    render(<Harness />)
    expect((within(main()).getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(main()).getByRole("button", { name: "Next step" }))
    expect(within(main()).getByRole("heading", { level: 2, name: "Predict" })).toBeTruthy()
    fireEvent.click(within(main()).getByRole("button", { name: "Back" }))
    expect(within(main()).getByRole("heading", { level: 2, name: "Read the idea" })).toBeTruthy()
    fireEvent.click(railSteps()[2])
    expect(within(main()).getByText("It was cut in two.")).toBeTruthy()
    expect(railSteps()[2].getAttribute("aria-current")).toBe("step")
  })

  it("ends on a recap that says what the lesson showed, then marks it done and offers the next lesson", () => {
    render(<Harness />)
    fireEvent.click(railSteps()[3])
    for (const line of RECAP) expect(within(main()).getByText(line)).toBeTruthy()
    expect((within(main()).getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(main()).getByRole("link", { name: "Next: How citations work" }).getAttribute("href")).toBe("/learn/citations")
    fireEvent.click(within(main()).getByRole("link", { name: "Mark as done" }))
    expect(readProgress()).toMatchObject({ chunking: true })
  })

  it("keeps the document beside the step and marks the sentence the step is about", async () => {
    render(<Harness />)
    await waitFor(() => expect(within(doc()).getByText(/chunking-primer\.pdf, 3 pages/)).toBeTruthy())
    // The pages view boxes the sentence on its page.
    await waitFor(() => expect(doc().querySelectorAll("[data-highlight]").length).toBe(1))
    fireEvent.click(within(doc()).getByRole("tab", { name: "Text" }))
    expect(within(doc()).getByText(SENTENCE, { selector: "mark" })).toBeTruthy()
    // Step 2 is about no sentence, so nothing is marked.
    fireEvent.click(railSteps()[1])
    expect(doc().querySelector("mark")).toBeNull()
  })

  it("flips between the lesson and the document on a narrow screen", () => {
    render(<Harness />)
    const panes = screen.getByRole("tablist", { name: "Panes" })
    expect(shell().getAttribute("data-pane")).toBe("lesson")
    fireEvent.click(within(panes).getByRole("tab", { name: "Document" }))
    expect(shell().getAttribute("data-pane")).toBe("document")
    fireEvent.click(within(panes).getByRole("tab", { name: "Lesson" }))
    expect(shell().getAttribute("data-pane")).toBe("lesson")
  })
})
