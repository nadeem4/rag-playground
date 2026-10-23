import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Against, EvalQuestionResult, EvaluationResult } from "@/api/types"
import { v2 } from "@/api/v2"

import { afterRun, BEST_KEY, bestHeadline, bestKey, forgetBest, readBest, scoredRun, whenText, type BestPipeline } from "./best"

const PIPELINE: BestPipeline = {
  config: { index: { parse: { use: "docling" }, chunk: { use: "recursive_character" }, store: { use: "lancedb" } } },
  documents: [{ sha: "cd".repeat(32), filename: "primer.pdf" }],
  question: { text: "", gold_answers: [] },
}

const q = (id: string, found: boolean, over: Partial<EvalQuestionResult> = {}) =>
  ({ id, question: `Question ${id}?`, golds: [], tags: [], found, rank: found ? 1 : null, lost_at: null, trace: null, score: null, error: null, result_id: null, ...over }) as unknown as EvalQuestionResult

/** A report as the server sends it, with the totals worked out the server's way: errored questions are not scored. */
function report(questions: EvalQuestionResult[], over: Partial<EvaluationResult> = {}): EvaluationResult {
  const scored = questions.filter((x) => !x.error)
  const found = scored.filter((x) => x.found).length
  return {
    top_k: 5,
    cancelled: false,
    total: questions.length,
    scored: scored.length,
    found,
    hit_rate: scored.length ? found / scored.length : null,
    mrr: scored.length ? found / scored.length : null,
    recall: null,
    mean_rank: null,
    median_rank: null,
    by_tag: {},
    questions,
    questions_fingerprint: "f1",
    document_shas: ["cd".repeat(32)],
    ...over,
  }
}

const run = (r: EvaluationResult, name = "Mine", at = new Date("2026-10-16T21:40:00")) => afterRun(r, name, PIPELINE, at)

/** Pandion's verdict, as `POST /api/v2/evaluations/against` gives it. The pairing itself is Pandion's and tested there. */
const verdict = (over: Partial<Against> = {}): Against => ({
  found_before: 0, found_now: 0, compared: 0, newly_missed: [], newly_found: [], unmatched: [], partial: false, notes: [], ok: true, best: [0, 1], ...over,
})
const judge = (over: Partial<Against> = {}) => vi.spyOn(v2, "against").mockResolvedValue(verdict(over))

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("Best so far", () => {
  it("keys a run by its question set, its documents and its pieces checked, and has none without a fingerprint", () => {
    const k = bestKey(report([q("a", true)]))
    expect(k).not.toBeNull()
    expect(bestKey(report([q("a", true)], { questions_fingerprint: "f2" }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { top_k: 3 }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { document_shas: ["ab".repeat(32)] }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { questions_fingerprint: undefined }))).toBeNull()
  })

  it("keys a run on the document each question names too, and leaves a set naming none keyed as before", () => {
    const plain = report([q("a", true)])
    expect(bestKey(plain)).toBe(JSON.stringify(["f1", ["cd".repeat(32)], 5]))
    expect(bestKey(report([q("a", true, { document: null })]))).toBe(bestKey(plain))
    const one = bestKey(report([q("a", true, { document: "cd".repeat(32) })]))
    expect(one).not.toBe(bestKey(plain))
    expect(bestKey(report([q("a", true, { document: "ab".repeat(32) })]))).not.toBe(one)
  })

  it("names the documents in the first run's headline when there are several", () => {
    expect(bestHeadline({ kind: "first" })).toBe("Your first run with these questions, so it is your best so far.")
    expect(bestHeadline({ kind: "first" }, 1)).toBe("Your first run with these questions, so it is your best so far.")
    expect(bestHeadline({ kind: "first" }, 3)).toBe("Your first run with these 3 documents and questions, so it is your best so far.")
  })

  it("makes the first run with a question set the best, keeping what Pandion compares, and asks nothing", async () => {
    const against = judge()
    const r = report([q("a", true), q("b", false, { error: "boom" })], { nondeterministic: ["llm_rerank"] })
    expect((await run(r)).outcome).toEqual({ kind: "first" })
    const stored = readBest(bestKey(r)!)!
    expect(stored).toEqual({ found: 1, scored: 1, mrr: 1, hit_rate: 1, name: "Mine", pipeline: PIPELINE, at: expect.any(String), report: scoredRun(r) })
    expect(stored.report).toEqual({
      top_k: 5, questions_fingerprint: "f1", document_shas: ["cd".repeat(32)], nondeterministic: ["llm_rerank"], scored: 1, found: 1, hit_rate: 1, mrr: 1,
      questions: [
        { id: "a", question: "Question a?", found: true, error: null },
        { id: "b", question: "Question b?", found: false, error: "boom" },
      ],
    })
    expect(new Date(stored.at).getTime()).toBe(new Date("2026-10-16T21:40:00").getTime())
    expect(against).not.toHaveBeenCalled()
  })

  it("asks Pandion with this run and the best as kept", async () => {
    await run(report([q("a", true)]), "Best one")
    const kept = readBest(bestKey(report([]))!)!.report
    const against = judge({ best: [0] })
    const now = report([q("a", false)])
    await run(now)
    expect(against).toHaveBeenCalledWith(scoredRun(now), kept)
  })

  it("says a worse run, with the lost questions by their text and Pandion's notes, and keeps the best", async () => {
    await run(report([q("a", true), q("b", true)]), "Best one")
    judge({ best: [0], newly_missed: ["a"], notes: ["llm_rerank can give a different result each run."] })
    const { outcome } = await run(report([q("a", false), q("b", true)]), "Worse one")
    expect(outcome).toMatchObject({ kind: "worse", fewer: 1, lost: ["Question a?"], notes: ["llm_rerank can give a different result each run."] })
    if (outcome.kind !== "worse") return
    expect(outcome.best.name).toBe("Best one")
    expect(bestHeadline(outcome)).toBe("1 fewer found than your best.")
    expect(readBest(bestKey(report([]))!)!.name).toBe("Best one")
  })

  it("names the questions a better run lost too", async () => {
    await run(report([q("a", true), q("b", false), q("c", false)]), "Old")
    judge({ best: [1], newly_found: ["b", "c"], newly_missed: ["a"] })
    const { outcome } = await run(report([q("a", false), q("b", true), q("c", true)]), "New")
    expect(outcome).toMatchObject({ kind: "better", more: 1, won: ["Question b?", "Question c?"], lost: ["Question a?"] })
  })

  it("says a better run, with the won questions, and makes it the best", async () => {
    await run(report([q("a", true), q("b", false), q("c", false)]), "Old")
    judge({ best: [1], newly_found: ["b", "c"] })
    const { outcome } = await run(report([q("a", true), q("b", true), q("c", true)]), "New")
    expect(outcome).toMatchObject({ kind: "better", more: 2, won: ["Question b?", "Question c?"], tie: false })
    if (outcome.kind === "better") expect(outcome.before.name).toBe("Old")
    expect(readBest(bestKey(report([]))!)!.name).toBe("New")
  })

  it("says an equal run and keeps the best as it was", async () => {
    await run(report([q("a", true), q("b", false)]), "First")
    judge({ best: [0, 1] })
    const { outcome } = await run(report([q("a", false), q("b", true)]), "Second")
    expect(outcome).toMatchObject({ kind: "equal", found: 1, scored: 2, notes: [] })
    expect(readBest(bestKey(report([]))!)!.name).toBe("First")
  })

  it("says a lower hit rate when Pandion names no lost question", async () => {
    await run(report([q("a", true)]), "Best")
    judge({ best: [0] })
    const { outcome } = await run(report([q("a", true), q("b", false)]))
    expect(outcome.kind === "worse" && bestHeadline(outcome)).toBe("A lower hit rate than your best.")
  })

  it("says the best ranks higher only when the hit rates are equal", async () => {
    await run(report([q("a", true), q("b", false)], { mrr: 0.5 }), "Best")
    judge({ best: [0] })
    const { outcome } = await run(report([q("a", true), q("b", false)], { mrr: 0.25 }))
    expect(outcome.kind === "worse" && bestHeadline(outcome)).toBe("Your best ranks the answers higher.")
  })

  it("does not compare with another question set's or another top_k's best", async () => {
    await run(report([q("a", true), q("b", true)]))
    const against = judge()
    expect((await run(report([q("a", false), q("b", false)], { questions_fingerprint: "other" }))).outcome).toEqual({ kind: "first" })
    expect((await run(report([q("a", false), q("b", false)], { top_k: 3 }))).outcome).toEqual({ kind: "first" })
    expect(against).not.toHaveBeenCalled()
  })

  it("reads a best kept before Pandion compared runs, positional questions by their place", async () => {
    const key = bestKey(report([]))!
    const old = {
      found: 1, scored: 1, hit_rate: 1, mrr: 1, name: "Old", pipeline: PIPELINE, at: "2026-10-01T10:00:00.000Z",
      questions: [
        { id: null, text: "Where?", found: true, errored: false },
        { id: "b", text: "Why?", found: false, errored: true },
      ],
    }
    window.localStorage.setItem(BEST_KEY, JSON.stringify({ [key]: old }))
    expect(readBest(key)!.report).toEqual({
      top_k: 5, questions_fingerprint: "f1", document_shas: ["cd".repeat(32)], nondeterministic: [], scored: 1, found: 1, hit_rate: 1, mrr: 1,
      questions: [
        { id: "question 1", question: "Where?", found: true, error: null },
        { id: "b", question: "Why?", found: false, error: "not scored" },
      ],
    })
  })

  it("forgets the best for one key only", async () => {
    const r = report([q("a", true)])
    const other = report([q("a", true)], { top_k: 3 })
    await run(r)
    await run(other)
    forgetBest(bestKey(r)!)
    expect(readBest(bestKey(r)!)).toBeNull()
    expect(readBest(bestKey(other)!)).not.toBeNull()
  })

  it("keeps working when storage throws: every run reads as a first run", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const r = report([q("a", true)])
    expect((await run(r)).outcome).toEqual({ kind: "first" })
    expect(readBest(bestKey(r)!)).toBeNull()
    expect(() => forgetBest(bestKey(r)!)).not.toThrow()
  })

  it("reads anything else under its key as no best", async () => {
    window.localStorage.setItem(BEST_KEY, "not json")
    expect((await run(report([q("a", true)]))).outcome).toEqual({ kind: "first" })
    window.localStorage.setItem(BEST_KEY, JSON.stringify({ [bestKey(report([]))!]: { found: "x" } }))
    expect((await run(report([q("a", true)]))).outcome).toEqual({ kind: "first" })
  })

  it("passes on Pandion's refusal: the page then shows no box", async () => {
    await run(report([q("a", true)]))
    vi.spyOn(v2, "against").mockRejectedValue(new Error("down"))
    await expect(run(report([q("a", false)]))).rejects.toThrow("down")
  })
})

describe("whenText", () => {
  const now = new Date("2026-10-16T22:00:00")
  it("says today at the time, or the day and the time", () => {
    expect(whenText(new Date("2026-10-16T21:40:00").toISOString(), now)).toBe("today at 21:40")
    expect(whenText(new Date("2026-10-14T09:05:00").toISOString(), now)).toBe("on 14 Oct at 09:05")
  })
})
