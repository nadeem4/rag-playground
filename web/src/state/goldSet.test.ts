import { beforeEach, describe, expect, it } from "vitest"

import type { GoldQuestion, QuestionSetUpload, SampleQuestion } from "@/api/types"

import {
  clearTabSet,
  inUse,
  mismatch,
  questionsFromSample,
  questionsFromSet,
  readTabSet,
  report,
  reportLines,
  storeTabSet,
} from "./goldSet"

const SHA = "cd".repeat(32)
const OTHER = "ab".repeat(32)
const NOTE = "The gold passages were looked for in the document as the pdfium parser reads it."

const question = (over: Partial<GoldQuestion>): GoldQuestion => ({
  id: "",
  question: "",
  gold_answers: [],
  answer: "",
  tags: [],
  document: "",
  ...over,
})

function set(over: Partial<QuestionSetUpload> = {}): QuestionSetUpload {
  return {
    sha: SHA,
    filename: "refunds.csv",
    format: "csv",
    count: 2,
    set: {
      version: 1,
      document: "handbook.pdf",
      questions: [
        question({ id: "refunds", question: "How long do refunds take?", gold_answers: ["Within ten working days."], tags: ["policy"] }),
        question({ question: "Who approves an exception?", gold_answers: ["The duty manager approves it."] }),
      ],
    },
    stored: true,
    parser: "pdfium",
    parser_note: NOTE,
    summary: { questions: 2, found: 1, found_normalized: 0, not_found: 1 },
    questions: [
      {
        index: 0,
        id: "refunds",
        question: "How long do refunds take?",
        status: "found",
        golds: [{ gold: "Within ten working days.", status: "found", document_text: "", closest: "" }],
      },
      {
        index: 1,
        id: "",
        question: "Who approves an exception?",
        status: "not_found",
        golds: [
          { gold: "The duty manager approves it.", status: "not_found", document_text: "", closest: "The duty manager signs it off." },
        ],
      },
    ],
    ...over,
  }
}

describe("the questions the page asks", () => {
  it("reads the built-in sample set, which has one gold passage and no tags", () => {
    const sample: SampleQuestion[] = [{ id: "a", question: "What are the two steps?", gold_answer: "It answers in two steps." }]
    expect(questionsFromSample(sample)).toEqual([
      { id: "a", question: "What are the two steps?", gold_answers: ["It answers in two steps."], tags: [] },
    ])
  })

  it("reads an uploaded set, and numbers the questions that brought no id of their own", () => {
    expect(questionsFromSet(set())).toEqual([
      { id: "refunds", question: "How long do refunds take?", gold_answers: ["Within ten working days."], tags: ["policy"] },
      { id: "q2", question: "Who approves an exception?", gold_answers: ["The duty manager approves it."], tags: [] },
    ])
  })

  it("reads nothing at all from a record whose set is missing", () => {
    expect(questionsFromSet({ sha: SHA, filename: "x.json", format: "json", count: 0 } as never)).toEqual([])
  })
})

describe("which set is in use, and whether it belongs to the loaded document", () => {
  it("is the uploaded set when there is one, and it belongs when the fingerprints agree", () => {
    expect(inUse(SHA, OTHER, set())).toEqual({ kind: "uploaded", belongs: true })
    expect(inUse(OTHER, OTHER, set())).toEqual({ kind: "uploaded", belongs: false })
  })

  it("is the built-in sample set otherwise, which belongs only to the sample document", () => {
    expect(inUse(SHA, SHA, null)).toEqual({ kind: "sample", belongs: true })
    expect(inUse(OTHER, SHA, null)).toEqual({ kind: "sample", belongs: false })
  })

  it("does not judge the sample set before the sample's fingerprint is known", () => {
    expect(inUse(SHA, null, null)).toEqual({ kind: "sample", belongs: null })
  })
})

describe("the warning when the set does not belong to the loaded document", () => {
  it("says nothing when the set belongs, or when it cannot be judged yet", () => {
    expect(mismatch({ kind: "sample", belongs: true }, "handbook.pdf")).toBeNull()
    expect(mismatch({ kind: "sample", belongs: null }, "handbook.pdf")).toBeNull()
    expect(mismatch({ kind: "uploaded", belongs: true }, "handbook.pdf")).toBeNull()
  })

  it("names the loaded document and offers the upload when the sample questions are the wrong ones", () => {
    const m = mismatch({ kind: "sample", belongs: false }, "handbook.pdf")!
    expect(m.fix).toBe("upload")
    expect(m.text).toContain("handbook.pdf")
    expect(m.text).toMatch(/sample document/)
  })

  it("offers to remove an uploaded set that was written for another document", () => {
    const m = mismatch({ kind: "uploaded", belongs: false }, "handbook.pdf")!
    expect(m.fix).toBe("remove")
    expect(m.text).toContain("handbook.pdf")
  })

  it("never uses an em-dash or an en-dash", () => {
    for (const u of [{ kind: "sample" as const, belongs: false }, { kind: "uploaded" as const, belongs: false }]) {
      expect(mismatch(u, "handbook.pdf")!.text).not.toMatch(/[–—]/)
    }
  })
})

describe("the upload report", () => {
  it("counts the questions read and the gold passages that were not found", () => {
    expect(report(set())).toEqual({
      filename: "refunds.csv",
      read: 2,
      passages: 2,
      normalized: 0,
      note: NOTE,
      problems: [{ question: "Who approves an exception?", gold_answer: "The duty manager approves it.", closest: "The duty manager signs it off." }],
    })
  })

  it("counts a passage that matched only after normalising, and keeps it out of the problems", () => {
    const r = report(
      set({
        questions: [
          {
            index: 0,
            id: "refunds",
            question: "How long do refunds take?",
            status: "found_normalized",
            golds: [
              { gold: "Within ten working days.", status: "found_normalized", document_text: "Within ten  working days.", closest: "" },
            ],
          },
        ],
      }),
    )
    expect(r).toMatchObject({ read: 2, passages: 1, normalized: 1, problems: [] })
  })

  it("has no closest text when the server found nothing close enough", () => {
    const r = report(
      set({
        questions: [
          { index: 0, id: "a", question: "Q", status: "not_found", golds: [{ gold: "G", status: "not_found", document_text: "", closest: "" }] },
        ],
      }),
    )
    expect(r.problems).toEqual([{ question: "Q", gold_answer: "G", closest: null }])
  })

  it("falls back to its own sentence about the parser when the server sent no note", () => {
    expect(report(set({ parser_note: "" })).note).toBe(
      "The check read the document with pdfium. A different parser can change the text.",
    )
  })

  it("reads as plain sentences that say what was read, what failed and which parser checked it", () => {
    expect(reportLines(report(set()))).toEqual([
      "Read 2 questions from refunds.csv.",
      "1 of 2 gold passages was not found in the document.",
      NOTE,
    ])
  })

  it("says so when every gold passage is in the document, and reports the ones that needed normalising", () => {
    const clean = set({
      filename: "questions.json",
      questions: [
        { index: 0, id: "a", question: "Q1", status: "found", golds: [{ gold: "G1", status: "found", document_text: "", closest: "" }] },
        {
          index: 1,
          id: "b",
          question: "Q2",
          status: "found_normalized",
          golds: [{ gold: "G2", status: "found_normalized", document_text: "G2.", closest: "" }],
        },
      ],
    })
    expect(reportLines(report(clean))).toEqual([
      "Read 2 questions from questions.json.",
      "All 2 gold passages are in the document.",
      "1 of them matched only after whitespace, quotes and line-end hyphens were normalised, so the file and the document word it differently.",
      NOTE,
    ])
  })

  it("never uses an em-dash or an en-dash", () => {
    expect(reportLines(report(set())).join(" ")).not.toMatch(/[–—]/)
  })
})

describe("a set the server would not store", () => {
  beforeEach(() => window.sessionStorage.clear())

  it("is nothing before anything is uploaded", () => {
    expect(readTabSet(SHA)).toBeNull()
  })

  it("comes back for the same document, and not for another one", () => {
    const s = set({ stored: false })
    storeTabSet(s)
    expect(readTabSet(SHA)).toEqual(s)
    expect(readTabSet(OTHER)).toBeNull()
  })

  it("goes when it is removed", () => {
    storeTabSet(set({ stored: false }))
    clearTabSet()
    expect(readTabSet(SHA)).toBeNull()
  })

  it("is nothing when the stored value is not a question set", () => {
    window.sessionStorage.setItem("rag-playground:gold-set", "{oops")
    expect(readTabSet(SHA)).toBeNull()
    window.sessionStorage.setItem("rag-playground:gold-set", JSON.stringify({ sha: SHA, set: { questions: 7 } }))
    expect(readTabSet(SHA)).toBeNull()
  })
})
