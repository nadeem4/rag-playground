import { useSyncExternalStore } from "react"

import { mergeById, type ImportResult } from "./pipelines"

/**
 * Saved experiments, read straight from the store Compare keeps them in, for
 * the Library page.
 *
 * TODO: switch to state/experiments.ts once it lands on main. Compare's own
 * store is being built on another branch, so this small adapter reads and
 * writes its localStorage key directly. The store may be absent here, and any
 * entry may be malformed, so every field is guarded and a bad entry is skipped.
 */

export interface ExperimentRecipe {
  transform: string
  config: Record<string, unknown>
}

export interface SavedExperiment {
  id: string
  name: string
  /** The step every recipe varies, such as "chunk" or "retrieve". */
  stage: string
  recipes: ExperimentRecipe[]
  doc: { sha: string; filename: string } | null
  savedAt: string
}

export const EXPERIMENTS_KEY = "rag-playground:experiments:v1"
/** Compare reads this id once on load and opens that experiment. */
export const OPEN_EXPERIMENT_KEY = "rag-playground:experiments:open"
export const MAX_EXPERIMENTS = 20

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function asRecipe(v: unknown): ExperimentRecipe | null {
  if (!isObject(v) || typeof v.transform !== "string") return null
  return { transform: v.transform, config: isObject(v.config) ? v.config : {} }
}

/** One stored entry as a SavedExperiment, or null when any field does not fit. */
export function asExperiment(v: unknown): SavedExperiment | null {
  if (!isObject(v)) return null
  const { id, name, stage, recipes, doc, savedAt } = v
  if (typeof id !== "string" || typeof name !== "string" || typeof stage !== "string" || typeof savedAt !== "string") return null
  if (!Array.isArray(recipes)) return null
  let ref: SavedExperiment["doc"] = null
  if (doc !== null && doc !== undefined) {
    if (!isObject(doc) || typeof doc.sha !== "string" || typeof doc.filename !== "string") return null
    ref = { sha: doc.sha, filename: doc.filename }
  }
  return { id, name, stage, savedAt, doc: ref, recipes: recipes.map(asRecipe).filter((r): r is ExperimentRecipe => r !== null) }
}

let cache: { raw: string | null; list: SavedExperiment[] } | null = null

export function readExperiments(): SavedExperiment[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(EXPERIMENTS_KEY)
  } catch {
    raw = null
  }
  if (cache && cache.raw === raw) return cache.list
  let list: SavedExperiment[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) list = parsed.map(asExperiment).filter((e): e is SavedExperiment => e !== null)
  } catch {
    list = []
  }
  cache = { raw, list }
  return list
}

function persist(list: SavedExperiment[]): boolean {
  try {
    if (list.length) window.localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(list))
    else window.localStorage.removeItem(EXPERIMENTS_KEY)
  } catch {
    return false
  }
  notify()
  return true
}

export function deleteExperiment(id: string): void {
  persist(readExperiments().filter((e) => e.id !== id))
}

export function clearExperiments(): void {
  persist([])
}

/** Add experiments from a file: by id, never duplicated, the newest twenty kept. Null when storage refused the write. */
export function importExperiments(incoming: SavedExperiment[]): ImportResult<SavedExperiment> | null {
  const valid = incoming.map(asExperiment).filter((e): e is SavedExperiment => e !== null)
  const { next, result } = mergeById(readExperiments(), valid, MAX_EXPERIMENTS)
  return persist(next) ? result : null
}

/** Mark the experiment Compare should open on its next load. */
export function openExperiment(id: string): void {
  try {
    window.sessionStorage.setItem(OPEN_EXPERIMENT_KEY, id)
  } catch {
    // Blocked storage: Compare opens as it would anyway.
  }
}

function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key === EXPERIMENTS_KEY) notify()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

export function useExperiments(): SavedExperiment[] {
  return useSyncExternalStore(subscribe, readExperiments, readExperiments)
}
