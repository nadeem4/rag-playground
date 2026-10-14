/**
 * REST client for the `/api` routes. In dev, Vite proxies `/api` to
 * http://127.0.0.1:8000; in production FastAPI serves the SPA itself, so the
 * same relative paths work in both.
 */

import type {
  AppSettings,
  LearnChunking,
  LearnDocument,
  LlmProvider,
  SampleCard,
  SampleQuestion,
  Source,
  StageInfo,
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

/** The request function for one base path: JSON in and out, `ApiError` on a non-2xx. */
export function requestFrom(base: string) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, init)
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // Not JSON (a proxy error page, say). Keep the text as the detail.
    }
    if (!res.ok) {
      const detail = body !== null && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body
      throw new ApiError(res.status, detail, path)
    }
    return body as T
  }
}

const request = requestFrom(API_BASE)

export const jsonInit = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
})

/** The header that carries each provider's key typed in the UI (plan I-8, I-18). */
export const KEY_HEADERS: Record<LlmProvider, string> = {
  anthropic: "X-Anthropic-Api-Key",
  openai: "X-OpenAI-Api-Key",
  custom: "X-Custom-Api-Key",
  openrouter: "X-OpenRouter-Api-Key",
}

/** UI keys by provider; null or absent when not set. */
export type UiKeys = Partial<Record<LlmProvider, string | null>>

/**
 * One header per UI key that is set, and nothing for the rest. Without it the
 * server falls back to its own environment or .env. A key goes nowhere else:
 * not a body, not a URL, not an error message.
 */
export function keyHeaders(keys?: UiKeys | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, header] of Object.entries(KEY_HEADERS) as [LlmProvider, string][]) {
    const k = keys?.[p]?.trim()
    if (k) out[header] = k
  }
  return out
}

/** Options for requests that may carry UI keys. */
export interface KeyOpts {
  keys?: UiKeys | null
}

export const api = {
  /** Plan I-12: one plain paragraph per stage. */
  stages: () => request<StageInfo>("/stages"),
  /** Plan I-22: the sample question, its answer sentence and the chunking challenges. */
  learnChunking: () => request<LearnChunking>("/learn/chunking"),
  /** The sample document the lessons work on: its name, its pages and its parsed text. */
  learnDocument: () => request<LearnDocument>("/learn/document"),

  /** The bundled sample cards offered on the first-visit card and in the Document menu, default first. */
  samples: () => request<SampleCard[]>("/samples"),
  /** Plan I-14: registers a bundled sample PDF like an upload. Idempotent. Omit `name` for the default sample. */
  sampleSource: (name?: string) =>
    request<Source>(
      "/sources/sample",
      name ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) } : { method: "POST" },
    ),
  /** Plan I-25: the committed question set for a sample, a bare array. */
  sampleQuestions: (name: string) => request<SampleQuestion[]>(`/samples/${encodeURIComponent(name)}/questions`),

  /** Plan I-31: a filled-in example set to start from. */
  questionTemplateUrl: (format: "json" | "csv") => `${API_BASE}/questions/template?format=${format}`,

  /** `demo`: hosted demo mode, uploads private to the browser and bounded, key from the UI only. */
  appSettings: () => request<AppSettings>("/settings/app"),
}
