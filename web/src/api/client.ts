/**
 * REST client for the `/api` routes. In dev, Vite proxies `/api` to
 * http://127.0.0.1:8000; in production FastAPI serves the SPA itself, so the
 * same relative paths work in both.
 */

import type {
  ArtifactMeta,
  CacheCleared,
  CancelResponse,
  FindResult,
  LlmCheck,
  LlmSettings,
  PdfPageSize,
  Registry,
  RunCreated,
  RunRequest,
  RunSnapshot,
  Source,
  SweepRequest,
} from "./types"

export const API_BASE = "/api"

/** A non-2xx response. `detail` is FastAPI's `detail` field when present. */
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(status: number, detail: unknown, path: string) {
    super(`${status} ${path}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init)
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Not JSON (a proxy error page, say). Keep the text as the detail.
  }
  if (!res.ok) {
    const detail =
      body !== null && typeof body === "object" && "detail" in body
        ? (body as { detail: unknown }).detail
        : body
    throw new ApiError(res.status, detail, path)
  }
  return body as T
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
})

/** The header that carries a key typed in the UI (plan I-8). */
export const KEY_HEADER = "X-Anthropic-Api-Key"

/**
 * The key header, present ONLY when a UI key is set. Without it the server
 * falls back to its own environment or .env. The key goes nowhere else: not a
 * body, not a URL, not an error message.
 */
export function keyHeaders(apiKey?: string | null): Record<string, string> {
  const k = apiKey?.trim()
  return k ? { [KEY_HEADER]: k } : {}
}

/** Options for requests that may carry a UI key. */
export interface KeyOpts {
  apiKey?: string | null
}

const sha = (s: string) => encodeURIComponent(s)

export const api = {
  registry: () => request<Registry>("/registry"),

  sources: () => request<Source[]>("/sources"),
  uploadSource: (file: File) => {
    const form = new FormData()
    form.append("file", file)
    return request<Source>("/sources", { method: "POST", body: form })
  },

  /** 400 on an invalid graph; 422 `{detail: {node_id, errors}}` on a bad config. */
  createRun: (body: RunRequest, opts: KeyOpts = {}) => request<RunCreated>("/runs", json(body, keyHeaders(opts.apiKey))),
  createSweep: (body: SweepRequest, opts: KeyOpts = {}) =>
    request<RunCreated>("/sweeps", json(body, keyHeaders(opts.apiKey))),
  run: (runId: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}`),
  /** 409 when the run has already finished. */
  cancelRun: (runId: string) =>
    request<CancelResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  /** `after`: resume after that event id, like a `Last-Event-ID` header. */
  eventsUrl: (runId: string, after?: number) =>
    `${API_BASE}/runs/${encodeURIComponent(runId)}/events` +
    (after !== undefined && after >= 0 ? `?last_event_id=${after}` : ""),

  artifact: (id: string) => request<ArtifactMeta>(`/artifacts/${encodeURIComponent(id)}`),
  artifactPayload: <T = unknown>(id: string) =>
    request<T>(`/artifacts/${encodeURIComponent(id)}/payload`),

  /** Which key source the SERVER can supply. Never a value. */
  llmSettings: () => request<LlmSettings>("/settings/llm"),
  /** Lists models with the resolved key: costs no tokens. */
  checkLlm: (opts: KeyOpts = {}) =>
    request<LlmCheck>("/settings/llm/check", { method: "POST", headers: keyHeaders(opts.apiKey) }),

  /** Page sizes in PDF points, 1-based `n`. */
  pages: (source: string) => request<PdfPageSize[]>(`/sources/${sha(source)}/pages`),
  pageImageUrl: (source: string, n: number, scale = 2) => `${API_BASE}/sources/${sha(source)}/pages/${n}.png?scale=${scale}`,
  findOnPage: (source: string, n: number, text: string) =>
    request<FindResult>(`/sources/${sha(source)}/pages/${n}/find?text=${encodeURIComponent(text)}`),

  /** 409 while a run is live. */
  clearCache: () => request<CacheCleared>("/cache", { method: "DELETE" }),
}
