/**
 * Hand-written mirrors of the engine's shapes. Sources of truth:
 *   registry  core/registry.py  Registry.export_schema()
 *   payloads  core/payloads.py
 *   events    core/executor.py + api/runs.py (the SSE stream)
 *
 * The fixtures in ./fixtures are generated from the real engine by
 * web/scripts/export_fixtures.py; types.test.ts checks these types against them.
 */

// ---------------------------------------------------------------- registry --

export type Stage =
  | "source"
  | "query"
  | "parse"
  | "clean"
  | "chunk"
  | "enrich"
  | "index"
  | "query_transform"
  | "retrieve"
  | "rerank"
  | "use_case"

export type ArtifactType =
  | "raw_file"
  | "query"
  | "parsed_doc"
  | "chunk_set"
  | "index"
  | "retrieval_result"
  | "output"
  | "qa_set"

export interface PortSchema {
  type: ArtifactType
  variadic: boolean
  ambient: boolean
  required: boolean
}

/** A Pydantic v2 `model_json_schema()`. Rendered by the schema form (B2). */
export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  $ref?: string
  $defs?: Record<string, JsonSchema>
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  [key: string]: unknown
}

export interface TransformInfo {
  name: string
  version: string
  stage: Stage
  output: ArtifactType
  stackable: boolean
  deterministic: boolean
  cacheable: boolean
  requires: Record<string, Record<string, unknown>>
  provides: Record<string, unknown>
  inputs: Record<string, PortSchema>
  config_schema: JsonSchema
  /** Plan I-11: how this strategy works, in plain language. Optional while older servers omit it. */
  summary?: string
}

/** `GET /api/registry`: stage -> transform name -> info. */
export type Registry = Partial<Record<Stage, Record<string, TransformInfo>>>

// ---------------------------------------------------------------- payloads --

export type ElementType =
  | "heading"
  | "paragraph"
  | "table"
  | "list_item"
  | "figure"
  | "caption"
  | "code"
  | "header"
  | "footer"
  | "footnote"
  | "formula"
  | "page_number"

export interface Element {
  id: string
  type: ElementType
  text: string
  order: number
  parent_id: string | null
  page: number | null
  bbox: [number, number, number, number] | null
  level: number | null
  md_start: number | null
  md_end: number | null
}

/** One row of a cleaner's diff. `reason` and `duplicate_of` vary by cleaner. */
export interface CleanReportRow {
  id: string
  type: ElementType
  page: number | null
  order: number
  preview: string
  reason?: string
  duplicate_of?: string
  [key: string]: unknown
}

/** One entry per cleaner application, appended in order. */
export interface CleanReportEntry {
  cleaner: string
  version: string
  config: Record<string, unknown>
  removed: CleanReportRow[]
  retyped: CleanReportRow[]
  removed_count: number
  kept_count: number
}

export interface ParserMeta {
  parser?: string
  clean_report?: CleanReportEntry[]
  [key: string]: unknown
}

export interface ParsedDoc {
  elements: Element[]
  page_count: number
  source_id: string
  filename: string
  doc_meta: Record<string, unknown>
  parser_meta: ParserMeta
}

export type ChunkKind = "chunk" | "summary" | "proposition" | "entity" | "community"

export interface Chunk {
  id: string
  text: string
  embed_text: string | null
  start_char: number
  end_char: number
  token_count: number
  kind: ChunkKind
  parent_id: string | null
  level: number
  ordinal: number
  doc_id: string
  heading_path: string[]
  source_element_ids: string[]
  page_span: [number, number] | null
  metadata: Record<string, unknown>
}

export interface ChunkSet {
  chunks: Chunk[]
  doc_id: string
  source_text: string
  chunker_meta: Record<string, unknown>
}

export interface Hit {
  chunk: Chunk
  score: number
  rank: number
  prior_rank: number | null
  prior_score: number | null
  matched_chunk_id: string
  expansion: "none" | "parent" | "window" | "doc"
  retriever: string
  component_scores: Record<string, number>
  highlights: [number, number][]
}

export interface RetrievalResult {
  hits: Hit[]
  query_id: string
  fetch_k: number
  total_candidates: number
  timings_ms: Record<string, number>
}

// ------------------------------------------------------------------ graph ---

export interface GraphNode {
  id: string
  stage: Stage
  transform: string
  config: Record<string, unknown>
}

export interface GraphEdge {
  src: string
  dst: string
  port: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Variant {
  transform: string
  config: Record<string, unknown>
}

// ---------------------------------------------------------------- REST I/O --

export interface RunRequest {
  graph: Graph
  overrides?: Record<string, Record<string, unknown>>
  targets?: string[]
  force?: boolean
}

export interface SweepRequest {
  graph: Graph
  node_id: string
  variants: Variant[]
  through?: string
  force?: boolean
}

export interface RunCreated {
  run_id: string
}

export interface CancelResponse {
  run_id: string
  cancel_requested: boolean
  detail: string
}

export interface Source {
  sha: string
  filename: string
  size: number
  content_type: string
}

export interface ArtifactMeta {
  id: string
  type: ArtifactType
  meta: Record<string, unknown>
}

export interface CacheCleared {
  artifacts: number
  bytes: number
  complete: boolean
}

export type RunStatus = "running" | "finished" | "cancelled" | "error"

/** `GET /api/runs/{id}`: everything needed to resync after a reconnect. */
export interface RunSnapshot {
  run_id: string
  kind: "run" | "sweep"
  status: RunStatus
  ok: boolean | null
  cancel_requested: boolean
  last_event_id: number
  events: RunEvent[]
}

// ------------------------------------------------------------------ events --
// Every SSE `data:` line is one of these, discriminated by `event`. The stream
// carries no `event:` field, so they all arrive through `onmessage`. Extra
// fields are tolerated: the index signature keeps new server fields legal.

interface EventBase {
  ts: number
  [key: string]: unknown
}

export interface RunStartedEvent extends EventBase {
  event: "run_started"
  nodes: string[]
  selected: string[]
}
export interface WarningEvent extends EventBase {
  event: "warning"
  message: string
}
export interface NodeStartedEvent extends EventBase {
  event: "node_started"
  node_id: string
  transform: string
  artifact_id: string
}
export interface NodeFinishedEvent extends EventBase {
  event: "node_finished"
  node_id: string
  artifact_id: string
  cache_hit: boolean
  duration_ms: number
}
export interface NodeFailedEvent extends EventBase {
  event: "node_failed"
  node_id: string
  error: string
}
export interface NodeSkippedEvent extends EventBase {
  event: "node_skipped"
  node_id: string
}
export interface RunCancelledEvent extends EventBase {
  event: "run_cancelled"
  skipped: string[]
}
export interface RunFinishedEvent extends EventBase {
  event: "run_finished"
  ok: boolean
  cancelled?: boolean
}
export interface VariantStartedEvent extends EventBase {
  event: "variant_started"
  index: number
  variant: Variant
}
export interface VariantFinishedEvent extends EventBase {
  event: "variant_finished"
  index: number
  ok: boolean
}
export interface RunErrorEvent extends EventBase {
  event: "run_error"
  error: string
}
/** Always the last event of a stream. The only safe point to close it. */
export interface StreamEndEvent extends EventBase {
  event: "stream_end"
  status: Exclude<RunStatus, "running">
  ok: boolean
}

export type RunEvent =
  | RunStartedEvent
  | WarningEvent
  | NodeStartedEvent
  | NodeFinishedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | RunCancelledEvent
  | RunFinishedEvent
  | VariantStartedEvent
  | VariantFinishedEvent
  | RunErrorEvent
  | StreamEndEvent

// ------------------------------------------------------------------- app --

/**
 * `GET /api/settings/app`. `demo`: a public host (`RAG_PLAYGROUND_DEMO=1`).
 * Uploads are refused, only the bundled sample is listed, and only a key
 * typed in the UI is used.
 */
export interface AppSettings {
  demo: boolean
}

// ------------------------------------------------------------ credentials --
// Plan I-8. The server reports only WHICH source it can supply, never a value.

/**
 * `GET /api/settings/llm`: the key the SERVER itself can supply. "none" means
 * the UI must supply one. A UI key is known only to the browser's own state.
 */
export type LlmServerSource = "env" | "dotenv" | "none"

export interface LlmSettings {
  source: LlmServerSource
}

/** `POST /api/settings/llm/check`. `source` is the key that was checked. */
export interface LlmCheck {
  ok: boolean
  source: "header" | "env" | "dotenv" | "none"
  error: string | null
}

// -------------------------------------------------------------- pdf pages --
// Plan I-9. Rects are (left, bottom, right, top) in PDF points, y growing up:
// the same convention as `Element.bbox`.

export type PdfRect = [number, number, number, number]

/** One entry of `GET /api/sources/{sha}/pages`. `n` is 1-based; sizes in points. */
export interface PdfPageSize {
  n: number
  width: number
  height: number
}

/** `GET /api/sources/{sha}/pages/{n}/find?text=...` */
export interface FindResult {
  rects: PdfRect[]
  matched: "exact" | "normalized" | "none"
}

// ------------------------------------------------------------------- chat --
// Plan I-10, the `use_case/chat` output.

/** A run of answer text. No citations means the text is NOT grounded in a source. */
export interface ChatSegment {
  text: string
  citations: number[]
}

/**
 * One citation. Numbers are shared across segments for an identical
 * (chunk, start, end). Nullable fields are real cases, and such citations are
 * still kept:
 *   page / element_id / bbox null   doc_start falls in no element span
 *                                   (the blank line between two blocks, say)
 *   chunk_id / doc_start / doc_end  the model cited a document outside the
 *     null, verified false          hits list
 */
export interface ChatCitation {
  n: number
  cited_text: string
  chunk_id: string | null
  source_sha: string
  /** Offsets into the parsed document's rendered markdown. */
  doc_start: number | null
  doc_end: number | null
  page: number | null
  element_id: string | null
  /** The element's bbox, not the cited text's. */
  bbox: PdfRect | null
  /** The document at doc_start..doc_end equals `cited_text`. */
  verified: boolean
}

export interface ChatPayload {
  question: string
  /** The model that ACTUALLY answered: a server-side fallback may differ from the configured one. */
  model: string
  answer: ChatSegment[]
  citations: ChatCitation[]
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: string | null
}

export interface ChatOutput {
  kind: "chat"
  payload: ChatPayload
}

// ----------------------------------------------------------- explanations --
// Plan I-11 / I-12.

/** `GET /api/stages`: what each step is for in RAG. */
export type StageInfo = Partial<Record<Stage, { what: string }>>

/** `POST /api/explain`: what a transform will do with THESE settings. */
export interface Explanation {
  settings: string
  tradeoff: string | null
  /** Settings valid in type that make no sense (overlap >= chunk size, say). */
  warning: string | null
  /** True: the UI disables Run. */
  blocking: boolean
}

export interface ExplainRequest {
  stage: Stage
  transform: string
  config: Record<string, unknown>
}
