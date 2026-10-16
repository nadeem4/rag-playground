import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EvalQuestionResult, EvaluationResult } from "@/api/types"

import { afterRun, best, BEST_KEY, bestHeadline, bestKey, forgetBest, readBest, whenText, type BestPipeline } from "./best"

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

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("best, the rule from pandion.evaluation.best", () => {
  const t = (found: number, scored: number, mrr: number | null = scored ? found / scored : null) => ({ found, scored, hit_rate: scored ? found / scored : null, mrr })

  it("matches the package's cases", () => {
    const two = t(2, 2)
    const one = t(1, 2)
    expect(best([one, two])).toEqual([1])
    expect(best([two, two])).toEqual([0, 1])
    expect(best([t(0, 1)])).toEqual([])
  })

  it("breaks a tie on hit rate by MRR, and skips a run that scored nothing", () => {
    expect(best([t(1, 2, 0.5), t(1, 2, 0.4)])).toEqual([0])
    expect(best([t(0, 0), t(1, 2)])).toEqual([1])
  })
})

describe("Best so far", () => {
  it("keys a run by its question set, its documents and its pieces checked, and has none without a fingerprint", () => {
    const k = bestKey(report([q("a", true)]))
    expect(k).not.toBeNull()
    expect(bestKey(report([q("a", true)], { questions_fingerprint: "f2" }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { top_k: 3 }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { document_shas: ["ab".repeat(32)] }))).not.toBe(k)
    expect(bestKey(report([q("a", true)], { questions_fingerprint: undefined }))).toBeNull()
  })

  it("makes the first run with a question set the best, and stores only what it needs", () => {
    const r = report([q("a", true), q("b", false)])
    expect(run(r).outcome).toEqual({ kind: "first" })
    const stored = readBest(bestKey(r)!)!
    expect(stored).toEqual({ found: 1, scored: 2, mrr: 0.5, hit_rate: 0.5, name: "Mine", pipeline: PIPELINE, at: expect.any(String),
      questions: [
        { id: "a", text: "Question a?", found: true, errored: false },
        { id: "b", text: "Question b?", found: false, errored: false },
      ],
    })
    expect(new Date(stored.at).getTime()).toBe(new Date("2026-10-16T21:40:00").getTime())
  })

  it("says a worse run, with the lost questions, and keeps the best", () => {
    run(report([q("a", true), q("b", true), q("c", false)]), "Best one")
    const { outcome } = run(report([q("a", false), q("b", true), q("c", false)]), "Worse one")
    expect(outcome.kind).toBe("worse")
    if (outcome.kind !== "worse") return
    expect(outcome.best.name).toBe("Best one")
    expect(outcome.fewer).toBe(1)
    expect(outcome.lost).toEqual(["Question a?"])
    expect(readBest(bestKey(report([]))!)!.name).toBe("Best one")
  })

  it("says a better run, with the won questions, and makes it the best", () => {
    run(report([q("a", true), q("b", false), q("c", false)]), "Old")
    const { outcome } = run(report([q("a", true), q("b", true), q("c", true)]), "New")
    expect(outcome.kind).toBe("better")
    if (outcome.kind !== "better") return
    expect(outcome.before.name).toBe("Old")
    expect(outcome.more).toBe(2)
    expect(outcome.won).toEqual(["Question b?", "Question c?"])
    expect(readBest(bestKey(report([]))!)!.name).toBe("New")
  })

  it("says an equal run and keeps the best as it was", () => {
    run(report([q("a", true), q("b", false)]), "First")
    const { outcome } = run(report([q("a", false), q("b", true)]), "Second")
    expect(outcome.kind).toBe("equal")
    expect(readBest(bestKey(report([]))!)!.name).toBe("First")
  })

  it("leaves errored questions out of lost and won", () => {
    run(report([q("a", true), q("b", false, { error: "boom" }), q("c", false)]), "Best")
    const { outcome } = run(report([q("a", false, { error: "boom" }), q("b", true), q("c", true)]))
    // a errored now, so it is not lost; b errored before, so it is not won.
    expect(outcome.kind).toBe("better")
    if (outcome.kind === "better") expect(outcome.won).toEqual(["Question c?"])
  })

  it("counts fewer over the questions both runs scored: a best of 9 of 9 (3 errored) against 11 of 12", () => {
    const ids = "abcdefghijkl".split("")
    // The best: the first nine found, the last three errored.
    run(report(ids.map((id, n) => (n < 9 ? q(id, true) : q(id, false, { error: "boom" })))), "Best")
    // This run: every question scored, and only "a" missed.
    const { outcome } = run(report(ids.map((id) => q(id, id !== "a"))))
    expect(outcome.kind).toBe("worse")
    if (outcome.kind !== "worse") return
    expect(outcome.fewer).toBe(1)
    expect(outcome.lost).toEqual(["Question a?"])
    expect(bestHeadline(outcome)).toBe("1 fewer found than your best.")
  })

  it("says a lower hit rate when no question both runs scored was lost", () => {
    const ids = "abcd".split("")
    run(report(ids.map((id, n) => (n < 3 ? q(id, true) : q(id, false, { error: "boom" })))), "Best")
    // Only "d" missed, and the best could not score "d": nothing paired was lost, yet 3 of 4 is below 3 of 3.
    const { outcome } = run(report(ids.map((id) => q(id, id !== "d"))))
    expect(outcome.kind).toBe("worse")
    if (outcome.kind !== "worse") return
    expect(outcome.fewer).toBe(0)
    expect(outcome.lost).toEqual([])
    expect(bestHeadline(outcome)).toBe("A lower hit rate than your best.")
  })

  it("says the best ranks higher only when the hit rates are equal", () => {
    run(report([q("a", true), q("b", false)], { mrr: 0.5 }), "Best")
    const { outcome } = run(report([q("a", true), q("b", false)], { mrr: 0.25 }))
    expect(outcome.kind).toBe("worse")
    if (outcome.kind === "worse") expect(bestHeadline(outcome)).toBe("Your best ranks the answers higher.")
  })

  it("has no false lost or won when the same set gains ids", () => {
    run(report([q("question 1", true, { question: "One?" }), q("question 2", false, { question: "Two?" })]), "Best")
    const same = run(report([q("one", true, { question: "One?" }), q("two", false, { question: "Two?" })])).outcome
    expect(same.kind).toBe("equal")
    // Better: only Two? is won; One? was found in both, under no id and then under its new one.
    const { outcome } = run(report([q("one", true, { question: "One?" }), q("two", true, { question: "Two?" })]))
    expect(outcome.kind === "better" && outcome.won).toEqual(["Two?"])
    expect(outcome.kind === "better" && outcome.more).toBe(1)
  })

  it("pairs by real id first, then by text for what is left", () => {
    // The best: "x" (found) and "y" (missed). This run: "x" under new text, missed, so it pairs by id;
    // and "Why?", which had the id "y" in the best, now with no id of its own, so it pairs by text.
    run(report([q("x", true, { question: "Same?" }), q("y", true, { question: "Why?" }), q("z", false, { question: "Gone?" })]), "Best")
    const { outcome } = run(report([q("x", false, { question: "Changed?" }), q("question 2", false, { question: "Why?" }), q("question 3", true, { question: "New?" })]))
    expect(outcome.kind === "worse" && outcome.lost).toEqual(["Changed?", "Why?"])
    // "New?" pairs with nothing, so it is never won.
    expect(outcome.kind === "worse" && outcome.fewer).toBe(2)
  })

  it("pairs a question with no id of its own by its text", () => {
    run(report([q("question 1", true, { question: "Where?" })]))
    const { outcome } = run(report([q("question 2", false, { question: "Where?" }), q("question 1", false, { question: "Elsewhere?" })]))
    expect(outcome.kind).toBe("worse")
    if (outcome.kind === "worse") expect(outcome.lost).toEqual(["Where?"])
  })

  it("does not compare with another question set's or another top_k's best", () => {
    run(report([q("a", true), q("b", true)]))
    expect(run(report([q("a", false), q("b", false)], { questions_fingerprint: "other" })).outcome).toEqual({ kind: "first" })
    expect(run(report([q("a", false), q("b", false)], { top_k: 3 })).outcome).toEqual({ kind: "first" })
  })

  it("forgets the best for one key only", () => {
    const r = report([q("a", true)])
    const other = report([q("a", true)], { top_k: 3 })
    run(r)
    run(other)
    forgetBest(bestKey(r)!)
    expect(readBest(bestKey(r)!)).toBeNull()
    expect(readBest(bestKey(other)!)).not.toBeNull()
  })

  it("keeps working when storage throws: every run reads as a first run", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const r = report([q("a", true)])
    expect(run(r).outcome).toEqual({ kind: "first" })
    expect(readBest(bestKey(r)!)).toBeNull()
    expect(() => forgetBest(bestKey(r)!)).not.toThrow()
  })

  it("reads anything else under its key as no best", () => {
    window.localStorage.setItem(BEST_KEY, "not json")
    expect(run(report([q("a", true)])).outcome).toEqual({ kind: "first" })
    window.localStorage.setItem(BEST_KEY, JSON.stringify({ [bestKey(report([]))!]: { found: "x" } }))
    expect(run(report([q("a", true)])).outcome).toEqual({ kind: "first" })
  })
})

describe("whenText", () => {
  const now = new Date("2026-10-16T22:00:00")
  it("says today at the time, or the day and the time", () => {
    expect(whenText(new Date("2026-10-16T21:40:00").toISOString(), now)).toBe("today at 21:40")
    expect(whenText(new Date("2026-10-14T09:05:00").toISOString(), now)).toBe("on 14 Oct at 09:05")
  })
})
