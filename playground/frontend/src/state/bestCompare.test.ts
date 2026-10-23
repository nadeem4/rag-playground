import { describe, expect, it } from "vitest"

import type { EvalQuestionResult, Registry, Trace } from "@/api/types"

import { pipelineDiff, questionGroups, rerunNote } from "./bestCompare"
import type { PipelineConfig } from "./config"

const base: PipelineConfig = {
  index: {
    parse: { use: "docling" },
    chunk: { use: "recursive_character", chunk_size: 800, chunk_overlap: 100 },
    store: { use: "lancedb" },
  },
  retrieve: { search: { use: "dense", top_k: 5 } },
}

describe("pipelineDiff", () => {
  it("names only the steps that differ, each side's strategy and the settings that differ, and lists the rest as the same", () => {
    const other: PipelineConfig = { ...base, index: { ...base.index, chunk: { use: "recursive_character", chunk_size: 400, chunk_overlap: 100 } } }
    expect(pipelineDiff(base, other)).toEqual({
      rows: [{ step: "Chunk", now: "Recursive (natural breaks), Chunk size 800 characters", other: "Recursive (natural breaks), Chunk size 400 characters" }],
      same: ["Parse", "Store", "Retrieve"],
    })
  })

  it("says None for a step one pipeline does not have, and shows each side's own settings when the strategies differ", () => {
    const other: PipelineConfig = {
      ...base,
      index: { ...base.index, chunk: { use: "layout_blocks", keep_tables_whole: true } },
      retrieve: { ...base.retrieve!, rerank: [{ use: "cross_encoder", top_k: 5 }] },
    }
    const { rows, same } = pipelineDiff(base, other)
    expect(rows).toEqual([
      { step: "Chunk", now: "Recursive (natural breaks), Chunk size 800 characters, Chunk overlap 100 characters", other: expect.stringMatching(/, Keep tables whole on$/) },
      { step: "Rerank", now: "None", other: expect.stringMatching(/, Candidates, top k 5 pieces$/) },
    ])
    expect(same).toEqual(["Parse", "Store", "Retrieve"])
  })

  it("words a setting by its schema's option label when the registry has one", () => {
    const registry = {
      parse: { docling: { config_schema: { properties: { table_mode: { type: "string", enum: ["fast", "accurate"] } } } } },
    } as unknown as Registry
    const now: PipelineConfig = { ...base, index: { ...base.index, parse: { use: "docling", table_mode: "fast" } } }
    const other: PipelineConfig = { ...base, index: { ...base.index, parse: { use: "docling", table_mode: "accurate" } } }
    const [row] = pipelineDiff(now, other, registry).rows
    expect(row.step).toBe("Parse")
    expect(row.now).toMatch(/Table mode /)
  })

  it("has no rows when the two pipelines are the same", () => {
    expect(pipelineDiff(base, structuredClone(base)).rows).toEqual([])
  })

  it("does not count settings kept in another order as a difference", () => {
    const other: PipelineConfig = { ...base, index: { ...base.index, chunk: { chunk_overlap: 100, chunk_size: 800, use: "recursive_character" } } }
    expect(pipelineDiff(base, other)).toEqual({ rows: [], same: ["Parse", "Chunk", "Store", "Retrieve"] })
  })
})

const trace = (lost: Trace["lost_at"], name: string): Trace => ({
  finding: "",
  lost_at: lost,
  fix: null,
  golds: [],
  steps: [{ stage: lost ?? "top_k", name, status: "lost", sentence: "", evidence: null }],
})

const q = (id: string, found: boolean, over: Partial<EvalQuestionResult> = {}) =>
  ({ id, question: `Question ${id}?`, golds: [], tags: [], found, rank: found ? 2 : null, lost_at: null, trace: null, score: null, error: null, result_id: null, ...over }) as unknown as EvalQuestionResult

describe("questionGroups", () => {
  it("puts each question in one group, with each run's rank or the step it was lost at", () => {
    const now = [q("a", true), q("b", false, { lost_at: "chunk", trace: trace("chunk", "Chunk") }), q("c", true, { rank: 1 }), q("d", false)]
    const other = [q("a", false, { lost_at: "rerank", trace: trace("rerank", "Rerank") }), q("b", true, { rank: 3 }), q("c", true), q("d", false)]
    expect(questionGroups(now, other)).toEqual({
      onlyOther: [{ id: "b", question: "Question b?", now: "missed, lost at Chunk", other: "rank 3" }],
      onlyNow: [{ id: "a", question: "Question a?", now: "rank 2", other: "missed, lost at Rerank" }],
      both: [{ id: "c", question: "Question c?", now: "rank 1", other: "rank 2" }],
      neither: [{ id: "d", question: "Question d?", now: "missed", other: "missed" }],
    })
  })

  it("leaves out a question either run could not score, or the other run did not ask", () => {
    const now = [q("a", true), q("b", false, { error: "boom" }), q("c", true)]
    const other = [q("a", true), q("b", true)]
    const groups = questionGroups(now, other)
    expect([...groups.onlyOther, ...groups.onlyNow, ...groups.both, ...groups.neither].map((x) => x.id)).toEqual(["a"])
  })
})

describe("rerunNote", () => {
  const stored = [
    { id: "a", question: "A?", found: true, error: null },
    { id: "b", question: "B?", found: false, error: null },
    { id: "c", question: "C?", found: true, error: null },
  ]

  it("says nothing when the run finds what the saved best found", () => {
    expect(rerunNote([q("a", true), q("b", false), q("c", true)], stored, [], "your best")).toBeNull()
  })

  it("counts the questions found differently, and names the steps that can vary", () => {
    expect(rerunNote([q("a", false), q("b", true), q("c", true)], stored, ["llm_rerank"], "your best")).toBe(
      "This time your best found 2 questions differently from when it was saved, so these groups can differ from the list above. llm_rerank can give a different result each run.",
    )
  })

  it("says honestly that something changed when no step says it can vary, and leaves out a question either side could not score", () => {
    expect(rerunNote([q("a", false), q("b", true, { error: "boom" }), q("d", true)], stored, [], "the last best")).toBe(
      "This time the last best found 1 question differently from when it was saved, so these groups can differ from the list above. None of its steps say they can vary, so something else changed since then, such as the server's version.",
    )
  })
})
