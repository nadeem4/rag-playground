import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SampleCard, SampleQuestion } from "@/api/types"

import {
  GUIDE_FIX,
  GUIDE_INVITE,
  GUIDE_QUESTION_ID,
  GUIDE_SAMPLE,
  GUIDE_STEPS,
  fill,
  guideGraph,
  readGuide,
  resetGuideForTests,
  setGuideHidden,
  setGuideStep,
  stageNode,
  useGuideHidden,
} from "./guide"
import { sampleGraph } from "./graph"
import { TEST_REGISTRY as R } from "./testRegistry"

const primer: SampleCard = {
  name: GUIDE_SAMPLE,
  title: "A primer on chunking",
  blurb: "",
  shows: "",
  stresses: "chunk",
  pages: 6,
  default: true,
  filename: "primer.pdf",
  sha: "ab".repeat(32),
  question: "How big is a chunk?",
}
const sizeFactors: SampleQuestion = {
  id: GUIDE_QUESTION_ID,
  question: "What three things decide a good chunk size for a collection?",
  gold_answer: "x",
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetGuideForTests()
})
afterEach(() => vi.restoreAllMocks())

describe("the guide steps", () => {
  it("are seven, in order", () => {
    expect(GUIDE_STEPS.map((s) => s.stage)).toEqual(["source", "parse", "clean", "chunk", "index", "ask", "fix"])
    expect(GUIDE_STEPS.map((s) => s.title.split(" ")[0])).toHaveLength(7)
    expect(GUIDE_STEPS[6].card).toBe("chunk")
  })

  it("have no dashes, no questions and no numbers in their text", () => {
    for (const s of GUIDE_STEPS) {
      for (const t of [s.title, s.body, s.run, s.why]) {
        expect(t).not.toMatch(/[–—]/)
        expect(t).not.toMatch(/\?/)
        expect(t).not.toMatch(/\d/)
        expect(t).not.toMatch(
          /\b(dozens?|hundreds?|thousands?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i,
        )
        expect(t.length).toBeGreaterThan(0)
      }
    }
  })

  it("fixes the sample, question and chunk settings", () => {
    expect(GUIDE_SAMPLE).toBe("chunking-primer")
    expect(GUIDE_QUESTION_ID).toBe("size-factors")
    expect(GUIDE_FIX).toEqual({ chunk_size: 800, chunk_overlap: 80 })
  })

  it("has invite copy without dashes", () => {
    expect(Object.values(GUIDE_INVITE).join(" ")).not.toMatch(/[–—]/)
  })
})

describe("fill", () => {
  it("replaces placeholders and leaves unknown ones", () => {
    expect(fill("{pages} pages, {size}, {x}", { pages: 6, size: "800" })).toBe("6 pages, 800, {x}")
  })
})

describe("guideGraph", () => {
  it("is the starter graph on the primer asking the size-factors question", () => {
    const g = guideGraph(R, [primer], [sizeFactors])!
    expect(g).toEqual(sampleGraph(R, { sha: primer.sha, filename: primer.filename }, sizeFactors.question))
    expect(stageNode(g, "ask")?.stage).toBe("retrieve")
    expect(stageNode(g, "chunk")?.config.chunk_size).toBe(400)
    expect(stageNode(g, "fix")).toBe(stageNode(g, "chunk"))
    expect(g.nodes.find((n) => n.stage === "query")?.config.text).toBe(sizeFactors.question)
  })

  it("is null without the sample or without the question", () => {
    expect(guideGraph(R, [primer], [])).toBeNull()
    expect(guideGraph(R, [{ ...primer, name: "other" }], [sizeFactors])).toBeNull()
    expect(guideGraph(R, null, [sizeFactors])).toBeNull()
  })
})

describe("guide storage", () => {
  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readGuide()).toEqual({ hidden: false, step: null })
  })

  it("keeps hidden and the step", () => {
    setGuideHidden(true)
    setGuideStep(3)
    expect(readGuide()).toEqual({ hidden: true, step: 3 })
    resetGuideForTests()
    expect(readGuide()).toEqual({ hidden: true, step: 3 })
    setGuideStep(null)
    expect(readGuide().step).toBeNull()
  })

  it("re-renders useGuideHidden on change", () => {
    const { result } = renderHook(() => useGuideHidden())
    expect(result.current).toBe(false)
    act(() => setGuideHidden(true))
    expect(result.current).toBe(true)
  })
})
