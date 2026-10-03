import { describe, expect, it } from "vitest"

import type { LearnChallenge, LearnChunking } from "@/api/types"

import { challengePrompt, outcomeText, strategyLabel } from "./challenges"
import type { ChunkAnalysis } from "./chunks"

const CHALLENGES: LearnChallenge[] = [
  { id: "shrink", title: "Shrink the chunks", strategy: "recursive_character", config: { chunk_size: 60, chunk_overlap: 0 }, expect_whole: false },
  { id: "room", title: "Give it room", strategy: "recursive_character", config: { chunk_size: 300, chunk_overlap: 0 }, expect_whole: true },
  { id: "naive", title: "The naive way", strategy: "token_based", config: { max_tokens: 20, overlap: 0 }, expect_whole: false },
  { id: "overlap", title: "Overlap to the rescue", strategy: "token_based", config: { max_tokens: 20, overlap: 18 }, expect_whole: true },
]

const DATA: LearnChunking = {
  question: "Why?",
  answer_sentence: "When a boundary falls in the middle of an explanation, neither half scores well.",
  sentence_chars: 81,
  sentence_tokens: 16,
  parse: { transform: "pdfium", config: {} },
  challenges: CHALLENGES,
}

const byId = (id: string) => CHALLENGES.find((c) => c.id === id)!

describe("strategyLabel", () => {
  it("names the two lesson strategies in plain words and passes others through", () => {
    expect(strategyLabel("recursive_character")).toBe("Recursive (natural breaks)")
    expect(strategyLabel("token_based")).toBe("Fixed token count")
    expect(strategyLabel("semantic")).toBe("semantic")
  })

  it("names the two structure chunkers in plain words", () => {
    expect(strategyLabel("layout_blocks")).toBe("By layout block")
    expect(strategyLabel("sentence_window")).toBe("By sentence")
  })

  it("names the three rerankers in plain words", () => {
    expect(strategyLabel("mmr")).toBe("MMR (variety)")
    expect(strategyLabel("cross_encoder")).toBe("Cross-encoder")
    expect(strategyLabel("llm_rerank")).toBe("LLM")
  })
})

describe("challengePrompt", () => {
  it("asks each challenge without giving the answer away", () => {
    expect(challengePrompt(byId("shrink"), DATA)).toBe(
      "Each chunk can hold 60 characters. Will the answer sentence, marked in the document, stay whole?",
    )
    expect(challengePrompt(byId("room"), DATA)).toBe("Now each chunk can hold 300 characters. Will the answer sentence stay whole?")
    expect(challengePrompt(byId("naive"), DATA)).toBe(
      "Now switch to Fixed token count, which cuts every time it counts 20 tokens, wherever that falls. A token is a word or a punctuation mark. Will the answer sentence stay whole?",
    )
    expect(challengePrompt(byId("overlap"), DATA)).toBe(
      "Keep Fixed token count, but repeat the last 18 tokens of each chunk at the start of the next. Will the answer sentence now appear whole in at least one chunk?",
    )
  })

  it("never states the sentence's length", () => {
    for (const ch of CHALLENGES) {
      const p = challengePrompt(ch, DATA)
      expect(p).not.toContain("characters long")
      expect(p).not.toContain("tokens long")
    }
  })

  it("names the strategy in plain words for any other challenge", () => {
    const other: LearnChallenge = { id: "extra", title: "Extra", strategy: "recursive_character", config: { chunk_size: 100 }, expect_whole: true }
    const p = challengePrompt(other, DATA)
    expect(p).toContain("Recursive (natural breaks)")
    expect(p).not.toContain("recursive_character")
  })
})

describe("outcomeText", () => {
  it("points to the next step when a careful cut crosses the sentence", () => {
    const a = { answerAt: [0, 81], whole: null, touching: [0, 1], chunks: [], repeated: 0 } as unknown as ChunkAnalysis
    const text = outcomeText("recursive_character", { chunk_size: 60, chunk_overlap: 0 }, a, DATA)
    expect(text).toContain("The chunks on the next step show where the cut fell.")
    expect(text).not.toContain("Look for the note in the chunks below.")
  })
})
