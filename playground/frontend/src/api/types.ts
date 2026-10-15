/**
 * Hand-written mirrors of the engine's shapes. Sources of truth:
 *   registry  packages/pandion/src/pandion/registry.py  Registry.export_schema()
 *   payloads  packages/pandion/src/pandion/payloads.py
 *   events    packages/pandion/src/pandion/executor.py + pandion-api's runs.py (the SSE stream)
 *
 * The fixtures in ./fixtures are generated from the real engine by
 * playground/frontend/scripts/export_fixtures.py; types.test.ts checks these types against them.
 */

import type { PipelineConfig, Step } from "@/state/config"

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
  /** The soft twin of `requires`: unmet, the transform still runs but falls back. */
  prefers: Record<string, Record<string, unknown>>
  /** One sentence saying what that fallback is. Empty unless `prefers` is set. */
  fallback: string
  inputs: Record<string, PortSchema>
  config_schema: JsonSchema
  /** Plan I-11: how this strategy works, in plain language. Optional while older servers omit it. */
  summary?: string
  /**
   * Plan I-22: a lesson per config field, plus `_strategy` for the transform
   * itself. Required for chunk-stage plugins; absent elsewhere for now.
   */
  learn?: Record<string, Lesson>
}

/** Plan I-22: one sentence under the field, and the paragraphs behind "Read more". */
export interface Lesson {
  hint: string
  more: string[]
}

/** `stages` of `GET /api/v2/strategies`: stage -> transform name -> info. */
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
  /** The full keyword query that ran when hybrid search expanded it (PRF); null when the question ran as written. */
  expanded_query?: string | null
  /** The words PRF added, best first. Empty without an expansion. */
  expansion_terms?: string[]
}

/** The query node's payload. Only the fields the client reads. */
export interface Query {
  /** What retrieval searches with: the question, or the model's rewrite of it. */
  text: string
  /** The question as typed, when `llm_rewrite` replaced `text`. Empty otherwise. */
  original?: string
  gold_answer?: string
  gold_answers?: string[]
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
  /** `GET /api/v2/documents` only: when this browser uploaded it (the demo's hours count from it). Absent for a sample. */
  uploaded_at?: string
}

/** One entry of `GET /api/samples`: a bundled sample document offered on the first-visit card and in the Document menu. */
export interface SampleCard {
  name: string
  title: string
  blurb: string
  shows: string
  stresses: Stage
  pages: number
  default: boolean
  filename: string
  sha: string
  /** The sample's own first question (F6), so loading it asks about itself. */
  question: string
}

export type RunStatus = "running" | "finished" | "cancelled" | "error"

/**
 * `GET /api/v2/runs/{id}`: everything needed to
 * resync after a reconnect, and on /api/v2 the run's `result` once it ended.
 */
export interface RunSnapshot {
  run_id: string
  kind: string
  status: RunStatus
  ok: boolean | null
  cancel_requested: boolean
  last_event_id: number
  events: RunEvent[]
  /** What the run returned, plain JSON, once it ended. Only /api/v2 sends it. */
  result?: unknown
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
export interface RunErrorEvent extends EventBase {
  event: "run_error"
  error: string
}
/** The demo is busy: the run waits its turn. `ahead` runs wait in front of it. */
export interface QueuedEvent extends EventBase {
  event: "queued"
  ahead: number
}
/** The run's turn came: it starts now. */
export interface UnqueuedEvent extends EventBase {
  event: "unqueued"
}
/** Always the last event of a stream. The only safe point to close it. */
export interface StreamEndEvent extends EventBase {
  event: "stream_end"
  status: Exclude<RunStatus, "running">
  ok: boolean
}

/** An evaluation's question is done: one per question, after its steps. */
export interface QuestionFinishedEvent extends EventBase {
  event: "question_finished"
  question: string
  number: number
  total: number
  found: boolean
  error: string | null
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
  | RunErrorEvent
  | QueuedEvent
  | UnqueuedEvent
  | StreamEndEvent
  | QuestionFinishedEvent

// ------------------------------------------------------------------- app --

/**
 * `GET /api/settings/app`. `demo`: a public host (`RAG_PLAYGROUND_DEMO=1`).
 * Uploads are private to the browser and bounded, and only a key typed in the
 * UI is used.
 */
export interface AppSettings {
  demo: boolean
  /** Demo mode only: the upload limits the server enforces, so the UI can state them. */
  limits?: { max_bytes: number; max_pages: number; max_files: number; max_total_bytes: number; ttl_hours: number }
}

// ------------------------------------------------------------ credentials --
// Plan I-8 and I-18. The server reports only WHICH source it can supply, never a value.

/** One key per provider. `custom` is the OpenAI-compatible endpoint. */
export type LlmProvider = "anthropic" | "openai" | "custom" | "openrouter"

/**
 * `GET /api/v2/settings/models`: the key the SERVER itself can supply. "none" means
 * the UI must supply one. A UI key is known only to the browser's own state.
 */
export type LlmServerSource = "env" | "dotenv" | "none"

export type LlmSettings = Record<LlmProvider, LlmServerSource>

/** `POST /api/v2/settings/models/check`. `source` is the key that was checked. */
export interface LlmCheck {
  ok: boolean
  source: "header" | "env" | "dotenv" | "none"
  error: string | null
}

// -------------------------------------------------------------- pdf pages --
// Plan I-9. Rects are (left, bottom, right, top) in PDF points, y growing up:
// the same convention as `Element.bbox`.

export type PdfRect = [number, number, number, number]

/** One entry of `GET /api/v2/documents/{sha}/pages`. `n` is 1-based; sizes in points. */
export interface PdfPageSize {
  n: number
  width: number
  height: number
}

/** `GET /api/v2/documents/{sha}/pages/{n}/find?text=...` */
export interface FindResult {
  rects: PdfRect[]
  matched: "exact" | "normalized" | "none"
}

// ------------------------------------------------------------------- chat --
// Plan I-10, the `use_case/chat` output.

/**
 * How a sentence-id claim is backed (plan I-19, I-20):
 *   cited       the model named sentences, and they support the claim
 *   weak        the model named sentences, but similarity is below the threshold
 *   similarity  no ids, but one shown sentence matches above the threshold
 *   none        no ids and nothing matches
 */
export type Grounding = "cited" | "weak" | "similarity" | "none"

/** A run of answer text. No citations means the text is NOT grounded in a source. */
export interface ChatSegment {
  text: string
  citations: number[]
  /** Plan I-20. Null (or absent) on native Claude segments, which keep the I-10 behaviour. */
  grounding?: Grounding | null
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
  /** Plan I-20: how the pointer was found. Absent on I-10 payloads. */
  method?: "native" | "id" | "similarity"
  /** Plan I-20: cosine similarity of claim and sentence; null for native. */
  support?: number | null
}

/** Plan I-20: claim counts per label, and marker ids that named no sentence. */
export interface GroundingStats {
  cited: number
  weak: number
  similarity: number
  none: number
  unknown_ids: number
}

export interface ChatPayload {
  question: string
  /** The model that ACTUALLY answered: a server-side fallback may differ from the configured one. */
  model: string
  answer: ChatSegment[]
  citations: ChatCitation[]
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: string | null
  /** Plan I-20; absent on I-10 payloads. */
  provider?: string
  /** Plan I-20: the method actually used. */
  citation_method?: "native" | "sentence_ids"
  stats?: GroundingStats
}

export interface ChatOutput {
  kind: "chat"
  payload: ChatPayload
}

// ----------------------------------------------------------- explanations --
// Plan I-11 / I-12.

/** `GET /api/stages`: what each step is for in RAG, and (plan I-22) its lesson paragraphs. */
export type StageInfo = Partial<Record<Stage, { what: string; lesson?: string[] }>>

// ------------------------------------------------------------------ learn --
// Plan I-22.

/** One predict-then-see challenge. `expect_whole` is what the backend's tests prove. */
export interface LearnChallenge {
  id: string
  title: string
  strategy: string
  config: Record<string, unknown>
  expect_whole: boolean
}

/** `GET /api/learn/chunking`. */
export interface LearnChunking {
  answer_sentence: string
  question: string
  /** The answer sentence's length as each chunker counts it. */
  sentence_chars: number
  sentence_tokens: number
  parse: { transform: string; config: Record<string, unknown> }
  challenges: LearnChallenge[]
}

/** `GET /api/learn/document`: the sample document every lesson works on. */
export interface LearnDocument {
  filename: string
  page_count: number
  /** The parsed text the steps work on, as the chunkers see it. */
  text: string
}

// ------------------------------------------------------------------- eval --
// Plan I-24 and I-25: the question set and the `use_case/eval` output.

/** One entry of `GET /api/samples/questions`, which returns a bare array. */
export interface SampleQuestion {
  id: string
  question: string
  gold_answer: string
  /** Further passages that also answer it, such as a table row as plain text. */
  gold_answers?: string[]
  /** The expected answer in words, shown beside the evidence and never scored. */
  answer?: string
  /** What the question tests, such as "designed to miss: footer" for a planted miss. */
  tags?: string[]
}

export type MatchKind = "exact" | "normalized" | "reworded" | "none"

export interface EvalPayload {
  question: string
  gold_answer: string
  /** The gold sentence was inside one of the top `top_k` hits. */
  hit: boolean
  /** 1-based rank of the first hit that contained it; null on a miss. */
  rank: number | null
  matched_chunk_id: string
  match: MatchKind
  /** How many hits were checked: `min(top_k, hits)`. */
  considered: number
  total_candidates: number
  /** Plan I-32: how many gold passages this question has. Absent on I-25 payloads. */
  golds_total?: number
  /** Plan I-32: how many of them appeared within `top_k`. Absent on I-25 payloads. */
  golds_found?: number
  /**
   * On a miss, the 1-based rank of the first piece below the top k that holds
   * a gold passage; null when none of the returned pieces does, and on a hit.
   * Absent on older payloads.
   */
  found_at?: number | null
  /**
   * How many pieces the retriever handed to the eval step. Not the same as
   * `total_candidates`, the pool they were picked from. Absent on older payloads.
   */
  returned?: number
}

export interface EvalOutput {
  kind: "eval"
  payload: EvalPayload
}

// -------------------------------------------------------- your own gold set --
// Plan I-30 and I-31. A question set is uploaded as JSON or CSV and stored
// against the document's fingerprint, so it can never be applied to the wrong
// document by accident.

/** One question of a set. Every field is present, empty where it was not given. */
export interface GoldQuestion {
  id: string
  question: string
  gold_answers: string[]
  answer: string
  tags: string[]
  /** The document its evidence is in; empty means the set's only document. Carried, not yet scored on. */
  document: string
}

/**
 * The upload check for one gold passage, against the document as `pdfium`
 * reads it. `found_normalized` carries the document's own wording so the file
 * can be fixed; `not_found` carries the closest sentence so a typo is obvious.
 * Both are empty strings when there is nothing to show.
 */
export type GoldCheckStatus = "found" | "found_normalized" | "not_found"

export interface GoldCheck {
  /** The passage as the file writes it. */
  gold: string
  status: GoldCheckStatus
  document_text: string
  closest: string
}

/** `status` is the worst of the question's passages. */
export interface GoldQuestionCheck {
  index: number
  id: string
  question: string
  status: GoldCheckStatus
  golds: GoldCheck[]
}

/** `GET /api/v2/documents/{sha}/questions`: the record the server keeps. */
export interface StoredQuestionSet {
  /** The document fingerprint this set is stored against. */
  sha: string
  /** The name of the file that was uploaded. */
  filename: string
  format: "json" | "csv"
  /** Questions read from the file. */
  count: number
  set: { version: number; document: string; questions: GoldQuestion[] }
}

/** `POST /api/v2/documents/{sha}/questions`: the record, plus the check it ran. */
export interface QuestionSetUpload extends StoredQuestionSet {
  /** False when the server would not keep it, as a hosted demo will not. */
  stored: boolean
  /** The parser the check read the document with, `pdfium` today. */
  parser: string
  parser_note: string
  summary: { questions: number; found: number; found_normalized: number; not_found: number }
  /** The check, one row per question. Not the questions themselves: those are `set.questions`. */
  questions: GoldQuestionCheck[]
}

/** `POST /api/v2/explain`: what a transform will do with THESE settings. */
export interface Explanation {
  settings: string
  tradeoff: string | null
  /** Settings valid in type that make no sense (overlap >= chunk size, say). */
  warning: string | null
  /** True: the UI disables Run. */
  blocking: boolean
}

// ------------------------------------------------------------ miss trace --

export type TraceStage = "parse" | "clean" | "chunk" | "search" | "rerank" | "top_k"

export interface TracePart {
  kind: "answer" | "other" | "context"
  text: string
}

export interface TraceStep {
  stage: TraceStage
  name: string
  status: "pass" | "lost" | "not_checked"
  sentence: string
  /** On a broken parse: the parsed text around the answer, the answer's words and the words between them. */
  evidence: { kind: "broken"; parts: TracePart[] } | null
}

export interface Trace {
  finding: string
  /** The first step that no longer held the answer; null when it came through. */
  lost_at: TraceStage | null
  fix: string | null
  golds: string[]
  steps: TraceStep[]
}

// ------------------------------------------------------------- /api/v2 --

export interface Strategies {
  stages: Registry
  defaults: Record<string, string>
}
export type Validated = { ok: true; problems: []; config: PipelineConfig; yaml: string } | { ok: false; problems: string[] }
export interface V2RunRequest {
  config: PipelineConfig
  documents: string[]
  through?: string
  force?: boolean
}
export interface V2AskRequest {
  config: PipelineConfig
  documents: string[]
  question: string
  k?: number
  answer?: boolean
  force?: boolean
}
export interface EvalQuestion {
  id: string
  question: string
  gold_answers: string[]
  tags: string[]
}
export interface EvaluationRequest {
  config: PipelineConfig
  documents: string[]
  questions: EvalQuestion[]
  top_k: number
}
/** The stages /api/v2/comparisons varies (pandion.evaluation.COMPARE_STAGES). */
export type CompareStage = "parse" | "clean" | "chunk" | "embed" | "store" | "rewrite" | "search" | "rerank"
export interface ComparisonRequest {
  config: PipelineConfig
  stage: CompareStage
  variants: (Step | Step[])[]
  documents: string[]
  questions?: EvalQuestion[]
  question?: string
  answer?: boolean
  top_k?: number
  /** Without a question: the step each recipe's index run stops after. */
  through?: string
}
export interface ResultInfo {
  id: string
  type: string
  meta: Record<string, unknown>
}
/** pandion.evaluation's totals: the server's arithmetic, never the browser's. */
export interface Totals {
  total: number
  scored: number
  found: number
  hit_rate: number | null
  mrr: number | null
  recall: number | null
  mean_rank: number | null
  median_rank: number | null
}
export interface EvalQuestionResult {
  id: string
  question: string
  golds: string[]
  tags: string[]
  found: boolean
  rank: number | null
  lost_at: string | null
  trace: Trace | null
  score: EvalPayload
  error: string | null
  result_id: string | null
}
export interface EvaluationResult extends Totals {
  top_k: number
  cancelled: boolean
  by_tag: Record<string, Totals>
  questions: EvalQuestionResult[]
}
/** What one step's model call used (pandion-api, "Speed and cost"); a count is null when the server sent none. */
export interface StepUsage {
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
}
/** Pandion's `cost()`: seconds, tokens, an estimate in dollars, and the cache share. */
export interface Cost {
  seconds: number
  input_tokens: number | null
  output_tokens: number | null
  /** Null when nothing was priced. */
  dollars: number | null
  unpriced_models: string[]
  uncounted_models: string[]
  steps_run: number
  steps_cached: number
  prices_as_of: string
}
export interface StepReport {
  stage: string
  strategy: string
  status: string
  result_id: string | null
  duration_ms: number | null
  note: string | null
  error: string | null
  /** Absent on results saved before speed and cost. */
  usage?: StepUsage | null
}
export interface RetrievalReport {
  ok: boolean
  index: StepReport | null
  steps: { rewrite: StepReport | null; search: StepReport | null; rerank: StepReport[] }
  hits: Hit[]
}
export interface AnswerReport extends RetrievalReport {
  answer: StepReport | null
  text: string
  output: unknown
}
export interface ComparisonItem {
  stage: CompareStage
  variant: Step | Step[]
  ok: boolean
  cancelled: boolean
  outputs?: Record<string, { artifact_id: string | null; status: string; transform: string }>
  report?: EvaluationResult | null
  retrieval?: RetrievalReport
  answer?: AnswerReport
  /** This recipe's whole cost, which depends on its place in the run. */
  cost?: Cost
  /** The varied step and after, as if this recipe had run on its own: the number to compare by. */
  varied_cost?: Cost
}
export interface ComparisonResult {
  comparisons: ComparisonItem[]
  best: number[]
  cancelled: boolean
  /** The stage the comparison varies. Absent, like the costs, on results saved before speed and cost. */
  varied_from?: string
  /** The steps before the varied one, each counted once. */
  shared_cost?: Cost
  /** Every recipe together, each step counted once. */
  cost?: Cost
}

/** `POST /api/project.zip`: the pipeline on Build, taken home as a project. */
export interface ProjectRequest {
  /** The pipeline in the file's shape, as runs send it. */
  config: unknown
  /** The pipeline's name; the zip is named after it. */
  name: string
  /** A question set, as Evaluate sends one. Left out, the project asks one example question. */
  questions?: unknown
  /** The Evaluate result to beat, one short line; empty for none. */
  scores: string
}

/** `POST /api/project.zip?preview=1`: the same files as text. */
export interface ProjectPreview {
  filename: string
  /** Each file by its path in the project, such as `docs/.gitkeep`. */
  files: Record<string, string>
  /** The settings the hosted demo held at its cap. */
  limited: { setting: string; value: number; cap: number }[]
  /** The environment variable of each key the pipeline reads; optional for a custom endpoint. */
  keys: { variable: string; optional: boolean }[]
  /** The most questions a project may hold (the demo's cap); null for no cap. */
  max_questions: number | null
}
