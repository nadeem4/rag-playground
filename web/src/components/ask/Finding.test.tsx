import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { SampleQuestion } from "@/api/types"
import type { HitRowData } from "@/components/inspectors/hits"

import { Finding } from "./Finding"

afterEach(cleanup)

const row = (rank: number, text: string): HitRowData => ({
  rank,
  score: 0.03,
  prior_rank: null,
  prior_score: null,
  retriever: "hybrid_rrf",
  component_scores: {},
  chunk_id: `c${rank}`,
  text,
  page_span: null,
  element_ids: null,
  ordinal: null,
  section: null,
})

const ROWS = [
  row(1, "The survey ran for six weeks. Two hundred readers took part."),
  row(2, "Readers were faster on one column. The average time per page fell by a fifth."),
  row(3, "Errors followed the same pattern! When a reader lost the thread, the cause was the jump."),
]
const QUESTIONS: SampleQuestion[] = [
  { id: "q1", question: "How fast were readers on one column?", gold_answer: "the average time per page fell by a fifth" },
  { id: "q2", question: "What caused the errors?", gold_answer: "not in any piece", gold_answers: ["the cause was the jump"] },
  { id: "q3", question: "What is missing?", gold_answer: "nowhere to be found" },
]

const sentence = () => screen.getByTestId("finding-sentence")

describe("Finding", () => {
  it("quotes the top piece's first sentence for a question outside the sample set, and invents nothing", () => {
    render(<Finding question="Who wrote the report?" rows={ROWS} questions={QUESTIONS} chat={false} />)
    const p = sentence()
    expect(p.textContent).toBe("The closest piece says: The survey ran for six weeks.")
    const doc = p.querySelector(".font-serif") as HTMLElement
    expect(doc.textContent).toBe("The survey ran for six weeks.")
    expect(ROWS[0].text.startsWith(doc.textContent!)).toBe(true)
    expect(doc.className).not.toContain("italic")
    expect(p.querySelector("q")).toBeNull()
  })

  it("says the closest piece when no question set is at hand", () => {
    render(<Finding question="How fast were readers on one column?" rows={ROWS} questions={[]} chat={false} />)
    expect(sentence().textContent).toBe("The closest piece says: The survey ran for six weeks.")
  })

  it("says the closest piece when the sample's question has no kept piece holding its gold", () => {
    render(<Finding question="What is missing?" rows={ROWS} questions={QUESTIONS} chat={false} />)
    expect(sentence().textContent).toBe("The closest piece says: The survey ran for six weeks.")
  })

  it("names the piece that holds the gold answer, quoted in the document voice", () => {
    render(<Finding question="How fast were readers on one column?" rows={ROWS} questions={QUESTIONS} chat={false} />)
    const p = sentence()
    expect(p.textContent).toBe("Found in the 2nd piece: the average time per page fell by a fifth")
    const q = p.querySelector("q") as HTMLElement
    expect(q.textContent).toBe("the average time per page fell by a fifth")
    expect(q.className).toContain("font-serif")
    expect(q.className).toContain("italic")
    expect(q.style.quotes).toContain("“")
  })

  it("matches one of the further gold answers too, and quotes the one found", () => {
    render(<Finding question="  What caused the errors? " rows={ROWS} questions={QUESTIONS} chat={false} />)
    expect(sentence().textContent).toBe("Found in the 3rd piece: the cause was the jump")
  })

  it("is in the tool's voice at the large size, balanced and at most 46 characters a line", () => {
    render(<Finding question="Who?" rows={ROWS} questions={QUESTIONS} chat={false} />)
    const p = sentence()
    for (const c of ["font-sans", "text-lg", "text-balance", "max-w-[46ch]"]) expect(p.className).toContain(c)
  })

  it("renders nothing with Chat: the written answer stands in", () => {
    const { container } = render(<Finding question="How fast were readers on one column?" rows={ROWS} questions={QUESTIONS} chat />)
    expect(container.innerHTML).toBe("")
  })

  it("renders nothing without rows", () => {
    const { container } = render(<Finding question="Who?" rows={[]} questions={QUESTIONS} chat={false} />)
    expect(container.innerHTML).toBe("")
  })
})
