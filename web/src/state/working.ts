import { graphToConfig, type WorkingPipeline } from "./config"

/**
 * Form 1 of the owner's two: the pipeline on Build, saved or not, as a config.
 * Navigation is a full page load, so localStorage carries it between pages;
 * within a page, `storeWorking` tells every subscriber. When a write fails (a
 * private window, blocked storage), it lives in memory for the rest of the page.
 *
 * Versions before part 5 kept a graph under OLD_GRAPH_KEY. It is converted
 * once, the first time nothing is stored here. One that cannot be converted
 * is marked under KEPT_KEY with the reason. The old key is never written or
 * removed, so the old pipeline is kept either way.
 */

export const WORKING_KEY = "rag-playground:pipeline:v2"
export const OLD_GRAPH_KEY = "rag-playground:graph:v1"
export const KEPT_KEY = "rag-playground:graph:v1:kept"

let memory: string | null = null
let storageFailed = false
const listeners = new Set<() => void>()

function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function set(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function isWorking(v: unknown): v is WorkingPipeline {
  if (!isRecord(v) || !isRecord(v.config) || !isRecord(v.config.index) || !Array.isArray(v.documents) || !isRecord(v.question)) return false
  return typeof v.question.text === "string" && Array.isArray(v.question.gold_answers)
}

export function parseWorking(json: string | null): WorkingPipeline | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return isWorking(v) ? v : null
  } catch {
    return null
  }
}

/** Convert the old working graph once, when nothing newer is stored. */
function migrate(): string | null {
  const old = get(OLD_GRAPH_KEY)
  if (old === null || get(KEPT_KEY) !== null) return null
  let parsed: unknown = null
  try {
    parsed = JSON.parse(old)
  } catch {
    // Not JSON: graphToConfig says it is not a pipeline.
  }
  const c = graphToConfig(parsed)
  if (!c.ok) {
    set(KEPT_KEY, JSON.stringify({ problem: c.problem, seen: false }))
    return null
  }
  const json = JSON.stringify(c.pipeline)
  memory = json
  if (!set(WORKING_KEY, json)) storageFailed = true
  return json
}

/** The stored JSON: a string, so a snapshot comparison is cheap. */
export function storedWorkingJson(): string | null {
  if (storageFailed) return memory
  let stored: string | null
  try {
    stored = window.localStorage.getItem(WORKING_KEY)
  } catch {
    // Reading is blocked: what this page stored lives in memory.
    return memory
  }
  return stored ?? migrate()
}

export function readWorking(): WorkingPipeline | null {
  return parseWorking(storedWorkingJson())
}

export function storeWorking(p: WorkingPipeline): void {
  const json = JSON.stringify(p)
  memory = json
  storageFailed = !set(WORKING_KEY, json)
  for (const l of [...listeners]) l()
}

export function subscribeWorking(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The reason the old working graph did not convert, and whether Build has said so. */
export function keptOldPipeline(): { problem: string; seen: boolean } | null {
  const raw = get(KEPT_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { problem?: unknown; seen?: unknown }
    return typeof v.problem === "string" ? { problem: v.problem, seen: v.seen === true } : null
  } catch {
    return null
  }
}

export function markKeptSeen(): void {
  const kept = keptOldPipeline()
  if (kept) set(KEPT_KEY, JSON.stringify({ ...kept, seen: true }))
}

/** Tests only: forget the in-memory copy. */
export function resetWorkingForTests(): void {
  memory = null
  storageFailed = false
}
