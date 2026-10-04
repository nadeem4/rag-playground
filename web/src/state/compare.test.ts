import { describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import { recipeNames } from "./compare"

const registry = liveRegistry as unknown as Registry

describe("recipeNames", () => {
  it("names chunk recipes by Build's plain names and the size that tells them apart", () => {
    const v = [
      { transform: "recursive_character", config: { chunk_size: 400, chunk_overlap: 80, heading_context: true } },
      { transform: "recursive_character", config: { chunk_size: 200, chunk_overlap: 40, heading_context: true } },
      { transform: "sentence_window", config: { sentences_per_chunk: 5, overlap_sentences: 1 } },
    ]
    const names = recipeNames(v, "chunk", registry)
    expect(names.map((n) => n.name)).toEqual([
      "Recursive (natural breaks), 400 characters",
      "Recursive (natural breaks), 200 characters",
      "By sentence",
    ])
    expect(names.map((n) => n.short)).toEqual(["400 characters", "200 characters", "By sentence"])
    expect(names.map((n) => n.code)).toEqual(["recursive_character", "recursive_character", "sentence_window"])
  })

  it("names search recipes as the Ask panel does", () => {
    const v = ["hybrid_rrf", "dense", "bm25"].map((t) => ({ transform: t, config: { top_k: 20 } }))
    expect(recipeNames(v, "retrieve", registry).map((n) => n.name)).toEqual(["Hybrid (RRF)", "Dense", "BM25"])
  })

  it("reads a null width as the native width", () => {
    const v = [null, 512].map((d) => ({ transform: "lancedb", config: { embedder: "qwen3-embedding-0.6b", truncate_dim: d } }))
    expect(recipeNames(v, "index", registry).map((n) => n.short)).toEqual(["native width", "512 dimensions"])
    expect(recipeNames(v, "index", registry)[1].name).toBe("LanceDB, 512 dimensions")
  })
})
