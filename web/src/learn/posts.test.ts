import { describe, expect, it } from "vitest"

import { POSTS, postsFor } from "./posts"

describe("the deep-dive posts", () => {
  it("every URL is a learnwithnk Medium post, and none repeats", () => {
    for (const p of POSTS) expect(p.url.startsWith("https://medium.com/learnwithnk/")).toBe(true)
    expect(new Set(POSTS.map((p) => p.url)).size).toBe(POSTS.length)
  })

  it("titles are unique", () => {
    expect(new Set(POSTS.map((p) => p.title)).size).toBe(POSTS.length)
  })

  it("every line is a sentence with no em-dash or en-dash", () => {
    for (const p of POSTS) {
      expect(p.line.endsWith(".")).toBe(true)
      expect(p.line).not.toMatch(/[–—]/)
    }
  })

  it("Rerank has no post yet, Chunk has three in list order", () => {
    expect(postsFor("rerank")).toEqual([])
    expect(postsFor("chunk").map((p) => p.title)).toEqual([
      "Chunking Fundamentals: What Chunk Size Actually Trades Off",
      "Advanced Chunking: Parent-Child, Contextual Retrieval, Late Chunking and Hierarchical Summaries",
      "Metadata and Enrichment: What to Store Beside Each Chunk",
    ])
  })

  it("Evaluate and the overview have their own posts", () => {
    expect(postsFor("evaluate")).toHaveLength(2)
    expect(postsFor("overview")).toHaveLength(4)
  })
})
