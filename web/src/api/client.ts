/**
 * REST client for the `/api` routes. In dev, Vite proxies `/api` to
 * http://127.0.0.1:8000; in production FastAPI serves the SPA itself, so the
 * same relative paths work in both.
 */

import type {
  ArtifactMeta,
  CacheCleared,
  CancelResponse,
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

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

export const api = {
  registry: () => request<Registry>("/registry"),

  sources: () => request<Source[]>("/sources"),
  uploadSource: (file: File) => {
    const form = new FormData()
    form.append("file", file)
    return request<Source>("/sources", { method: "POST", body: form })
  },

  /** 400 on an invalid graph; 422 `{detail: {node_id, errors}}` on a bad config. */
  createRun: (body: RunRequest) => request<RunCreated>("/runs", json(body)),
  createSweep: (body: SweepRequest) => request<RunCreated>("/sweeps", json(body)),
  run: (runId: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}`),
  /** 409 when the run has already finished. */
  cancelRun: (runId: string) =>
    request<CancelResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  eventsUrl: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/events`,

  artifact: (id: string) => request<ArtifactMeta>(`/artifacts/${encodeURIComponent(id)}`),
  artifactPayload: <T = unknown>(id: string) =>
    request<T>(`/artifacts/${encodeURIComponent(id)}/payload`),

  /** 409 while a run is live. */
  clearCache: () => request<CacheCleared>("/cache", { method: "DELETE" }),
}
