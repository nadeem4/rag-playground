import { useSyncExternalStore } from "react"

import type { Registry, Stage, Variant } from "@/api/types"

import { MAX_RECIPES } from "./compare"
import type { DocRef } from "./document"

/**
 * Saved Compare experiments: a step, its recipes and the document, by name,
 * kept in this browser as saved pipelines are. Nothing about a run is kept:
 * no run id, no artifact ids, no results. Running again is quick, because
 * finished steps come from the server's cache.
 */

export interface SavedExperiment {
  id: string
  name: string
  stage: Stage
  recipes: Variant[]
  doc: DocRef | null
  savedAt: string
}

/** What a save or an update writes. */
export interface ExperimentBody {
  stage: Stage
  recipes: Variant[]
  doc: DocRef | null
}

export const MAX_EXPERIMENTS = 20
const LIST_KEY = "rag-playground:experiments:v1"
/** Another page (the Library) asks Compare to open an experiment through this tab's session. */
const OPEN_KEY = "rag-playground:experiments:open"
const MAX_NAME = 80

let cache: SavedExperiment[] | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

function readRaw(): unknown {
  try {
    const raw = window.localStorage.getItem(LIST_KEY)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function write(value: string): boolean {
  try {
    window.localStorage.setItem(LIST_KEY, value)
    return true
  } catch {
    return false
  }
}

const isVariant = (v: unknown): v is Variant =>
  typeof v === "object" && v !== null && typeof (v as Variant).transform === "string" && typeof (v as Variant).config === "object" && (v as Variant).config !== null

const isDoc = (d: unknown): d is DocRef | null =>
  d === null || (typeof d === "object" && typeof (d as DocRef).sha === "string" && typeof (d as DocRef).filename === "string")

export const isExperiment = (e: unknown): e is SavedExperiment => {
  if (typeof e !== "object" || e === null) return false
  const x = e as SavedExperiment
  return (
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    typeof x.stage === "string" &&
    typeof x.savedAt === "string" &&
    Array.isArray(x.recipes) &&
    x.recipes.length >= 1 &&
    x.recipes.length <= MAX_RECIPES &&
    x.recipes.every(isVariant) &&
    isDoc(x.doc)
  )
}

export function readExperiments(): SavedExperiment[] {
  if (cache === null) {
    const parsed = readRaw()
    cache = Array.isArray(parsed) ? parsed.filter(isExperiment) : []
  }
  return cache
}

/** The list as storage holds it now: another tab may have saved since, so every change starts from this. */
function fresh(): SavedExperiment[] {
  cache = null
  return readExperiments()
}

/** Writes the list, and only then updates what this tab holds. */
function persist(next: SavedExperiment[]): boolean {
  const ok = write(JSON.stringify(next))
  if (ok) {
    cache = next
    notify()
  }
  return ok
}

function cleanName(name: string): string | null {
  const t = name.trim()
  return t.length >= 1 && t.length <= MAX_NAME ? t : null
}

function newId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 8)
}

const entry = (id: string, name: string, b: ExperimentBody): SavedExperiment => ({
  id,
  name,
  stage: b.stage,
  recipes: structuredClone(b.recipes),
  doc: b.doc ? { sha: b.doc.sha, filename: b.doc.filename } : null,
  savedAt: new Date().toISOString(),
})

/** The new experiment, and the oldest one if keeping twenty meant dropping it, so the page can say so. */
export function saveExperiment(name: string, body: ExperimentBody): { saved: SavedExperiment; dropped: SavedExperiment | null } | null {
  const clean = cleanName(name)
  if (!clean) return null
  const saved = entry(newId(), clean, body)
  const list = fresh()
  const next = [...list, saved]
  // The oldest goes first: the list keeps the order they were saved in.
  const dropped = next.length > MAX_EXPERIMENTS ? [...next].sort((a, b) => a.savedAt.localeCompare(b.savedAt))[0] : null
  const kept = dropped ? next.filter((e) => e !== dropped) : next
  if (!persist(kept)) return null
  return { saved, dropped }
}

/** The line that says a save pushed the oldest experiment out. */
export const droppedText = (dropped: SavedExperiment) => `Saved. ${dropped.name}, the oldest experiment, was removed to keep ${MAX_EXPERIMENTS}.`

/** Writes new recipes, step and document over a saved experiment, keeping its name; false when it is gone. */
export function updateExperiment(id: string, body: ExperimentBody): boolean {
  const list = fresh()
  const old = list.find((e) => e.id === id)
  if (!old) return false
  return persist(list.map((e) => (e.id === id ? entry(id, old.name, body) : e)))
}

export function deleteExperiment(id: string): void {
  persist(fresh().filter((e) => e.id !== id))
}

/**
 * The experiment as this server can run it, or null. Storage is per browser
 * but the registry is per server, so an experiment made against another
 * server's strategies is listed but cannot be opened.
 */
export function usableExperiment(e: SavedExperiment, registry: Registry): SavedExperiment | null {
  const strategies = registry[e.stage]
  return strategies && e.recipes.every((r) => r.transform in strategies) ? e : null
}

/** Ask Compare, on its next mount in this tab, to open the experiment. */
export function requestOpenExperiment(id: string): void {
  try {
    window.sessionStorage.setItem(OPEN_KEY, id)
  } catch {
    // Storage blocked: Compare opens on its own recipes.
  }
}

/** The experiment another page asked Compare to open, read once and cleared. */
export function takeOpenRequest(): string | null {
  try {
    const id = window.sessionStorage.getItem(OPEN_KEY)
    if (id !== null) window.sessionStorage.removeItem(OPEN_KEY)
    return id
  } catch {
    return null
  }
}

/** Another tab changed the list: drop what this tab cached and read again. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== LIST_KEY) return
  cache = null
  notify()
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

export function resetExperimentsForTests(): void {
  cache = null
}
