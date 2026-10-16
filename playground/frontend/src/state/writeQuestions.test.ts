import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import {
  chatModels,
  clampCount,
  defaultModel,
  keptSet,
  reviewItems,
  reviewSummary,
  usageLine,
  writtenBy,
  writtenFilename,
  type WrittenSet,
} from "./writeQuestions"

const registry = liveRegistry as unknown as Registry
const NO_KEYS = { anthropic: null, openai: null, custom: null, openrouter: null }

const written: WrittenSet = {
  questions: [
    { id: "q1", question: "What two steps does RAG use?", gold_answers: ["First it finds passages."], answer: "Find, then answer.", tags: [] },
    { id: "q2", question: "Why start a chunk at a heading?", gold_answers: ["A heading is a promise."], answer: "", tags: ["copied"] },
  ],
  dropped: [{ question: "What is chunk size?", reason: "Its gold passage is a heading, not a sentence." }],
  usage: { input_tokens: 8674, output_tokens: 2677, model: "claude-sonnet-5" },
}

describe("chatModels", () => {
  it("lists only the chat models whose provider has a key in this browser", () => {
    expect(chatModels(registry, NO_KEYS)).toEqual([])
    const anthropic = chatModels(registry, { ...NO_KEYS, anthropic: "sk-ant" })
    expect(anthropic.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"])
    expect(anthropic[1]).toEqual({ id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" })
    const both = chatModels(registry, { ...NO_KEYS, anthropic: "sk-ant", openai: "sk-oa" })
    expect(both.map((m) => m.provider)).toContain("openai")
    // OpenRouter and a custom endpoint need more than a key, so they are not offered here.
    expect(chatModels(registry, { ...NO_KEYS, openrouter: "or", custom: "c" })).toEqual([])
  })

  it("defaults to the cheapest Anthropic model when there is one", () => {
    expect(defaultModel(chatModels(registry, { ...NO_KEYS, anthropic: "k", openai: "k" }))).toBe("claude-haiku-4-5")
    expect(defaultModel(chatModels(registry, { ...NO_KEYS, openai: "k" }))).toBe("gpt-6-astra")
    expect(defaultModel([])).toBeNull()
  })
})

describe("clampCount", () => {
  it("keeps the count between 1 and the cap", () => {
    expect(clampCount(0, 25)).toBe(1)
    expect(clampCount(40, 25)).toBe(25)
    expect(clampCount(Number.NaN, 25)).toBe(1)
    expect(clampCount(7.6, 25)).toBe(8)
  })
})

describe("review", () => {
  it("counts what is kept, dropped, copied and edited", () => {
    const items = reviewItems(written)
    expect(reviewSummary(items)).toEqual({ keep: 2, dropped: 0, copied: 1, edited: 0 })
    const changed = [{ ...items[0], question: "Which two steps?" }, { ...items[1], dropped: true }]
    expect(reviewSummary(changed)).toEqual({ keep: 1, dropped: 1, copied: 0, edited: 1 })
  })

  it("says the model and its tokens in one line", () => {
    expect(usageLine("Claude Sonnet 5", written.usage)).toBe("Claude Sonnet 5, 8,674 in / 2,677 out tokens")
    expect(usageLine("Claude Sonnet 5", { input_tokens: null, output_tokens: null, model: null })).toBe("Claude Sonnet 5, tokens not reported")
  })

  it("makes the kept questions, with edits, into a set the upload reads", () => {
    const items = reviewItems(written)
    const set = keptSet([{ ...items[0], question: "Which two steps?" }, { ...items[1], dropped: true }], "chunking-primer.pdf")
    expect(set).toEqual({
      version: 1,
      document: "chunking-primer.pdf",
      questions: [{ id: "q1", question: "Which two steps?", gold_answers: ["First it finds passages."], answer: "Find, then answer.", tags: [] }],
    })
  })
})

describe("the written set's file name", () => {
  it("names the model, and the name gives it back", () => {
    expect(writtenFilename("Claude Sonnet 5")).toBe("questions written by Claude Sonnet 5.json")
    expect(writtenBy(writtenFilename("Claude Sonnet 5"))).toBe("Claude Sonnet 5")
    expect(writtenBy("refunds.csv")).toBeNull()
  })
})
