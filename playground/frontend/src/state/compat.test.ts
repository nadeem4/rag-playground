import { describe, expect, it } from "vitest"

import type { TransformInfo } from "@/api/types"

import { compatibility } from "./compat"

function info(over: Partial<TransformInfo>): TransformInfo {
  return {
    name: "x",
    version: "1",
    stage: "chunk",
    output: "chunk_set",
    stackable: false,
    deterministic: true,
    cacheable: true,
    requires: {},
    provides: {},
    prefers: {},
    fallback: "",
    inputs: {},
    config_schema: { type: "object", properties: {} },
    ...over,
  } as TransformInfo
}

const docling = info({ name: "docling", stage: "parse", provides: { structure: ["headings"] } })
const pdfium = info({ name: "pdfium", stage: "parse", provides: {} })
const lancedb = info({ name: "lancedb", stage: "index", provides: { backends: ["dense", "fts"] } })
const denseOnly = info({ name: "dense_only", stage: "index", provides: { backends: ["dense"] } })

const headings = info({
  name: "markdown_header",
  prefers: { doc: { structure: ["headings"] } },
  fallback: "The whole document is treated as one section and cut by size.",
})
const bm25 = info({ name: "bm25", stage: "retrieve", requires: { index: { backends: ["fts"] } } })
const hybrid = info({ name: "hybrid_rrf", stage: "retrieve", requires: { index: { backends: ["dense", "fts"] } } })

describe("compatibility", () => {
  it("is ok when the upstream provides what is preferred", () => {
    expect(compatibility(headings, { doc: docling })).toEqual({ kind: "ok" })
  })

  it("is ok when a transform asks for nothing", () => {
    expect(compatibility(info({ name: "recursive_character" }), { doc: pdfium })).toEqual({ kind: "ok" })
  })

  it("is ok when the port has no upstream to judge", () => {
    expect(compatibility(headings, {})).toEqual({ kind: "ok" })
  })

  it("is soft, with the fallback in the reason, when a preference is unmet", () => {
    expect(compatibility(headings, { doc: pdfium })).toEqual({
      kind: "soft",
      reason: "Needs headings from the parse step. pdfium does not find any, so the whole document is treated as one section and cut by size.",
    })
  })

  it("is hard, and says it cannot run, when a requirement is unmet", () => {
    expect(compatibility(bm25, { index: denseOnly })).toEqual({
      kind: "hard",
      reason: "Needs text search from the index step. dense_only does not provide it, so this cannot run.",
    })
    expect(compatibility(bm25, { index: lancedb })).toEqual({ kind: "ok" })
  })

  it("names every missing capability, not just the first", () => {
    expect(compatibility(hybrid, { index: info({ name: "empty", stage: "index" }) })).toEqual({
      kind: "hard",
      reason: "Needs a dense index and text search from the index step. empty does not provide it, so this cannot run.",
    })
  })

  it("hard wins over soft when both are unmet", () => {
    const both = info({
      name: "picky",
      requires: { doc: { structure: ["headings"] } },
      prefers: { doc: { structure: ["tables"] } },
      fallback: "Tables are cut like paragraphs.",
    })
    expect(compatibility(both, { doc: pdfium }).kind).toBe("hard")
  })
})
