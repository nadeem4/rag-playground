/**
 * REST client for pandion-api's routes under /api/v2: the only routes the web
 * calls once part 5 is done. Keys travel in the same headers as on /api, and
 * nowhere else: not a body, not a URL.
 */


import { jsonInit, keyHeaders, requestFrom, type KeyOpts } from "./client"
import type {
  Against,
  CancelResponse,
  ChunkStats,
  ComparisonRequest,
  EvaluationRequest,
  Explanation,
  FindGoldResult,
  FindResult,
  LlmCheck,
  LlmProvider,
  LlmSettings,
  PdfPageSize,
  QuestionSetAcross,
  QuestionSetAcrossUpload,
  QuestionSetUpload,
  ResultInfo,
  RunCreated,
  RunSnapshot,
  ScoredRun,
  Source,
  StoredQuestionSet,
  Strategies,
  V2AskRequest,
  V2RunRequest,
} from "./types"

export const V2_BASE = "/api/v2"
const request = requestFrom(V2_BASE)
const id = (s: string) => encodeURIComponent(s)
const form = (file: File) => {
  const f = new FormData()
  f.append("file", file)
  return f
}

export const v2 = {
  strategies: () => request<Strategies>("/strategies"),
  /** 404 for an unknown stage or strategy, 422 `{detail: {problems}}` for a bad setting. */
  explain: (body: { stage: string; use: string; settings: Record<string, unknown> }, signal?: AbortSignal) =>
    request<Explanation>("/explain", { ...jsonInit(body), signal }),
  /** 200 either way: `{ok, problems}`; a site rule's refusal keeps its status (403). */

  documents: () => request<Source[]>("/documents"),
  uploadDocument: (file: File) => request<Source>("/documents", { method: "POST", body: form(file) }),
  /** Fetch a page once and keep it like an upload. A refusal is the fetch guard's own sentence (400, 403, 413, 415, 429, 502, 503 or 504). */
  addLink: (url: string) => request<Source>("/documents/url", jsonInit({ url })),
  deleteDocument: (sha: string) => request<{ sha: string; deleted: boolean }>(`/documents/${id(sha)}`, { method: "DELETE" }),
  documentFileUrl: (sha: string) => `${V2_BASE}/documents/${id(sha)}/file`,
  pages: (sha: string) => request<PdfPageSize[]>(`/documents/${id(sha)}/pages`),
  pageImageUrl: (sha: string, n: number, scale = 2) => `${V2_BASE}/documents/${id(sha)}/pages/${n}?scale=${scale}`,
  findOnPage: (sha: string, n: number, text: string) =>
    request<FindResult>(`/documents/${id(sha)}/pages/${n}/find?text=${encodeURIComponent(text)}`),
  /** The stored set, or null when there is none. */
  questionSet: (sha: string) => request<StoredQuestionSet | null>(`/documents/${id(sha)}/questions`),
  uploadQuestionSet: (sha: string, file: File) =>
    request<QuestionSetUpload>(`/documents/${id(sha)}/questions`, { method: "POST", body: form(file) }),
  /** The sets kept against several documents, as one. */
  questionSetAcross: (shas: readonly string[]) =>
    request<QuestionSetAcross>(`/questions?${shas.map((s) => `documents=${id(s)}`).join("&")}`),
  /** One set for several documents: each question checked in the document it names, kept split by document. */
  uploadQuestionSetAcross: (shas: readonly string[], file: File) => {
    const body = form(file)
    for (const sha of shas) body.append("documents", sha)
    return request<QuestionSetAcrossUpload>("/questions", { method: "POST", body })
  },
  /** Which piece first holds a gold passage, by the eval step's own rule: `found` is null when none does. */
  findGold: (body: { golds: string[]; texts: string[] }, signal?: AbortSignal) =>
    request<FindGoldResult>("/golds/find", { ...jsonInit(body), signal }),
  deleteQuestionSet: (sha: string) => request<unknown>(`/documents/${id(sha)}/questions`, { method: "DELETE" }),
  /** A model writes a question set for the document, as a run of kind `questions`. The set is handed back, never kept. */
  generateQuestions: (sha: string, body: { model: string; count: number }, opts: KeyOpts = {}) =>
    request<RunCreated>(`/documents/${id(sha)}/questions/generate`, jsonInit(body, keyHeaders(opts.keys))),

  createRun: (body: V2RunRequest, opts: KeyOpts = {}) => request<RunCreated>("/runs", jsonInit(body, keyHeaders(opts.keys))),
  ask: (body: V2AskRequest, opts: KeyOpts = {}) => request<RunCreated>("/ask", jsonInit(body, keyHeaders(opts.keys))),
  /** A run compared with a baseline by Pandion: lost and won questions by id, its notes, and which is better. Nothing runs. */
  against: (report: ScoredRun, baseline: ScoredRun) => request<Against>("/evaluations/against", jsonInit({ report, baseline })),
  createEvaluation: (body: EvaluationRequest, opts: KeyOpts = {}) =>
    request<RunCreated>("/evaluations", jsonInit(body, keyHeaders(opts.keys))),
  createComparison: (body: ComparisonRequest, opts: KeyOpts = {}) =>
    request<RunCreated>("/comparisons", jsonInit(body, keyHeaders(opts.keys))),
  run: (runId: string) => request<RunSnapshot>(`/runs/${id(runId)}`),
  /** 409 when the run has already finished. */
  cancelRun: (runId: string) => request<CancelResponse>(`/runs/${id(runId)}/cancel`, { method: "POST" }),
  eventsUrl: (runId: string, after?: number) =>
    `${V2_BASE}/runs/${id(runId)}/events` + (after !== undefined && after >= 0 ? `?last_event_id=${after}` : ""),

  result: (resultId: string) => request<ResultInfo>(`/results/${id(resultId)}`),
  resultPayload: <T = unknown>(resultId: string) => request<T>(`/results/${id(resultId)}/payload`),
  /** One chunker's chunk sets for several documents, summed up as one by `pandion.chunk.stats`. */
  chunkStats: (ids: string[]) => request<ChunkStats>("/chunk-stats", jsonInit({ ids })),

  /** Where the server's own key for each provider comes from. Never a key. */
  modelSources: () => request<LlmSettings>("/settings/models"),
  checkModel: (provider: LlmProvider, opts: KeyOpts = {}) =>
    request<LlmCheck>("/settings/models/check", jsonInit({ provider }, keyHeaders({ [provider]: opts.keys?.[provider] }))),
}
