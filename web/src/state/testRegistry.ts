import type { JsonSchema, PortSchema, Registry, Stage, TransformInfo } from "@/api/types"

/**
 * A small registry for unit tests, shaped like `GET /api/registry`. Tests use
 * this rather than the generated fixture so they do not depend on its exact
 * contents.
 */

const port = (type: PortSchema["type"]): PortSchema => ({ type, variadic: false, ambient: false, required: true })
const ambient = (type: PortSchema["type"]): PortSchema => ({ ...port(type), ambient: true })
const variadic = (type: PortSchema["type"]): PortSchema => ({ ...port(type), variadic: true })

function t(
  stage: Stage,
  name: string,
  output: TransformInfo["output"],
  inputs: Record<string, PortSchema>,
  properties: Record<string, JsonSchema>,
  stackable = false,
): TransformInfo {
  return {
    name,
    version: "1",
    stage,
    output,
    stackable,
    deterministic: true,
    cacheable: true,
    requires: {},
    provides: {},
    inputs,
    config_schema: { type: "object", title: `${name}Config`, properties },
  }
}

export const TEST_REGISTRY: Registry = {
  source: {
    upload: t("source", "upload", "raw_file", {}, { sha: { type: "string", title: "Sha" }, filename: { type: "string", title: "Filename" } }),
  },
  parse: {
    pdfium: t("parse", "pdfium", "parsed_doc", { file: port("raw_file") }, { mode: { enum: ["text", "layout"], type: "string", default: "text", title: "Mode" } }),
  },
  clean: {
    header_footer_strip: t("clean", "header_footer_strip", "parsed_doc", { doc: port("parsed_doc") }, { min_page_ratio: { type: "number", default: 0.5, minimum: 0, maximum: 1, title: "Min Page Ratio" } }, true),
    dedupe_blocks: t("clean", "dedupe_blocks", "parsed_doc", { doc: port("parsed_doc") }, { similarity: { type: "number", default: 0.95, title: "Similarity" } }, true),
  },
  chunk: {
    recursive_character: t("chunk", "recursive_character", "chunk_set", { doc: port("parsed_doc") }, {
      chunk_size: { type: "integer", default: 1000, minimum: 1, title: "Chunk Size" },
      chunk_overlap: { type: "integer", default: 200, minimum: 0, title: "Chunk Overlap" },
    }),
    markdown_header: t("chunk", "markdown_header", "chunk_set", { doc: port("parsed_doc") }, { max_tokens: { type: "integer", default: 512, title: "Max Tokens" } }),
    token_based: t("chunk", "token_based", "chunk_set", { doc: port("parsed_doc") }, {
      max_tokens: { type: "integer", default: 256, title: "Max Tokens" },
      overlap: { type: "integer", default: 32, title: "Overlap" },
    }),
  },
  index: {
    lancedb: t("index", "lancedb", "index", { chunks: variadic("chunk_set") }, {
      embedder: { type: "string", default: "fake-deterministic", title: "Embedder" },
      truncate_dim: { anyOf: [{ type: "integer" }, { type: "null" }], default: null, title: "Truncate Dim" },
    }),
  },
  query: {
    text: t("query", "text", "query", {}, { text: { type: "string", default: "", title: "Text" } }),
  },
  retrieve: {
    dense: t("retrieve", "dense", "retrieval_result", { index: port("index"), query: ambient("query") }, { top_k: { type: "integer", default: 5, title: "Top K" } }),
    hybrid_rrf: t("retrieve", "hybrid_rrf", "retrieval_result", { index: port("index"), query: ambient("query") }, { top_k: { type: "integer", default: 5, title: "Top K" } }),
  },
  rerank: {
    mmr: t("rerank", "mmr", "retrieval_result", { result: port("retrieval_result"), query: ambient("query"), index: ambient("index") }, { lambda_mult: { type: "number", default: 0.5, title: "Lambda Mult" } }, true),
  },
  use_case: {
    search: t("use_case", "search", "output", { result: port("retrieval_result") }, { max_snippet_chars: { type: "integer", default: 400, title: "Max Snippet Chars" } }),
  },
}
