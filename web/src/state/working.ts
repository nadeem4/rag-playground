import { goldsOf, graphToConfig, type WorkingPipeline } from "./config"

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
 *
 * A stored pipeline this server cannot draw (a step uses a strategy it does
 * not have) is copied, as it was, under UNDRAWN_KEY before a page replaces it
 * with a Starter. Each such pipeline is kept once, beside any kept before.
 */

export const WORKING_KEY = "rag-playground:pipeline:v2"
export const OLD_GRAPH_KEY = "rag-playground:graph:v1"
export const KEPT_KEY = "rag-playground:graph:v1:kept"
export const UNDRAWN_KEY = "rag-playground:pipeline:v2:kept"

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
    // Only the gold answers that are text are kept, as graphToConfig keeps them.
    return isWorking(v) ? { ...v, question: { text: v.question.text, gold_answers: goldsOf(v.question.gold_answers) } } : null
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
  // Migrating in a snapshot read is safe when storage will not write: migrate
  // sets storageFailed and keeps the result in memory, so it runs once per page.
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

type Undrawn = { problem: string; seen: boolean; json: string }

function undrawnList(): Undrawn[] {
  try {
    const v = JSON.parse(get(UNDRAWN_KEY) ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((x): x is Undrawn => isRecord(x) && typeof x.problem === "string" && typeof x.json === "string") : []
  } catch {
    return []
  }
}

/** Keep a stored pipeline this server cannot draw, as it was. One already kept is not kept twice. */
export function keepUndrawn(json: string, problem: string): void {
  const list = undrawnList()
  if (list.some((k) => k.json === json)) return
  set(UNDRAWN_KEY, JSON.stringify([...list, { problem, seen: false, json }]))
}

/** Why the last kept pipeline could not be drawn, and whether Build has said so. */
export function keptUndrawn(): { problem: string; seen: boolean } | null {
  const last = undrawnList().at(-1)
  return last ? { problem: last.problem, seen: last.seen === true } : null
}

/** Build has said why: mark every kept pipeline as seen. */
export function markKeptSeen(): void {
  const kept = keptOldPipeline()
  if (kept) set(KEPT_KEY, JSON.stringify({ ...kept, seen: true }))
  const list = undrawnList()
  if (list.some((k) => !k.seen)) set(UNDRAWN_KEY, JSON.stringify(list.map((k) => ({ ...k, seen: true }))))
}

/** Tests only: forget the in-memory copy. */
export function resetWorkingForTests(): void {
  memory = null
  storageFailed = false
}
