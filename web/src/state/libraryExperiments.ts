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

/** The most recipes one experiment may carry, as Compare allows. Checked on what an import brings in. */
export const MAX_RECIPES = 10

/** An incoming entry fit to store: readable, and within MAX_RECIPES with every recipe readable. */
export function asIncomingExperiment(v: unknown): SavedExperiment | null {
  const e = asExperiment(v)
  const recipes = isObject(v) && Array.isArray(v.recipes) ? v.recipes : []
  if (!e || recipes.length > MAX_RECIPES || e.recipes.length !== recipes.length) return null
  return e
}

let cache: { raw: string | null; entries: unknown[]; list: SavedExperiment[] } | null = null
// Each projection's own stored object, so an export carries every field Compare wrote.
const rawFor = new WeakMap<SavedExperiment, Record<string, unknown>>()

function load(): { entries: unknown[]; list: SavedExperiment[] } {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(EXPERIMENTS_KEY)
  } catch {
    raw = null
  }
  if (cache && cache.raw === raw) return cache
  let entries: unknown[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) entries = parsed
  } catch {
    entries = []
  }
  const list: SavedExperiment[] = []
  for (const entry of entries) {
    const e = asExperiment(entry)
    if (!e) continue
    rawFor.set(e, entry as Record<string, unknown>)
    list.push(e)
  }
  cache = { raw, entries, list }
  return cache
}

export function readExperiments(): SavedExperiment[] {
  return load().list
}

/** The stored object a projection was read from, untouched. */
export function rawExperiment(e: SavedExperiment): Record<string, unknown> {
  return rawFor.get(e) ?? (e as unknown as Record<string, unknown>)
}

/** Write the raw entries back as they are. Entries this adapter cannot read are kept. */
function persist(entries: unknown[]): boolean {
  try {
    if (entries.length) window.localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(entries))
    else window.localStorage.removeItem(EXPERIMENTS_KEY)
  } catch {
    return false
  }
  notify()
  return true
}

export function deleteExperiment(id: string): void {
  persist(load().entries.filter((e) => !(isObject(e) && e.id === id)))
}

export function clearExperiments(): void {
  persist([])
}

/**
 * Add experiments from a file: by id, never duplicated, never removing one
 * already saved, at most twenty in all. Each incoming entry is stored as it
 * came (its `kind` tag aside). `invalid` counts entries refused as unreadable
 * or over MAX_RECIPES. Null when storage refused the write.
 */
export function importExperiments(incoming: readonly unknown[]): (ImportResult<SavedExperiment> & { invalid: number }) | null {
  const valid: SavedExperiment[] = []
  const rawOf = new Map<SavedExperiment, Record<string, unknown>>()
  for (const v of incoming) {
    const e = asIncomingExperiment(v)
    if (!e) continue
    const { kind: _kind, ...rest } = v as Record<string, unknown>
    rawOf.set(e, rest)
    valid.push(e)
  }
  const { entries } = load()
  const ids = new Set(entries.flatMap((e) => (isObject(e) && typeof e.id === "string" ? [e.id] : [])))
  const { add, result } = mergeById(ids, entries.length, valid, MAX_EXPERIMENTS)
  if (!persist([...entries, ...add.map((e) => rawOf.get(e))])) return null
  return { ...result, invalid: incoming.length - valid.length }
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
