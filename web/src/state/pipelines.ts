import { useSyncExternalStore } from "react"

import type { Registry } from "@/api/types"

import { loadGraph, type PipelineGraph } from "./graph"

/**
 * Saved pipelines: named copies of the Build graph, kept in this browser.
 * The working copy the Build page edits stays in its own key; choosing a saved
 * pipeline copies it into the working copy, and "Save changes" copies it back.
 * Results are cached by recipe on the server, so switching costs nothing.
 */

export interface SavedPipeline {
  id: string
  name: string
  graph: PipelineGraph
  savedAt: string
}

export const MAX_PIPELINES = 20
const LIST_KEY = "rag-playground:pipelines:v1"
const CURRENT_KEY = "rag-playground:pipelines:current"
const MAX_NAME = 60

let cache: SavedPipeline[] | null = null
let currentCache: string | null | undefined
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

function read<T>(key: string, parse: (raw: string) => T | null): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? parse(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export const isPipeline = (p: unknown): p is SavedPipeline =>
  typeof p === "object" && p !== null &&
  typeof (p as SavedPipeline).id === "string" && typeof (p as SavedPipeline).name === "string" &&
  typeof (p as SavedPipeline).savedAt === "string" &&
  Array.isArray((p as SavedPipeline).graph?.nodes) && Array.isArray((p as SavedPipeline).graph?.edges)

export function readPipelines(): SavedPipeline[] {
  if (cache === null) {
    const parsed = read(LIST_KEY, (raw) => JSON.parse(raw) as unknown)
    cache = Array.isArray(parsed) ? parsed.filter(isPipeline) : []
  }
  return cache
}

/**
 * The list as storage holds it now, not as this tab last saw it. Another tab
 * may have saved since (I4), so every change starts from this and never from
 * the cached list.
 */
function freshPipelines(): SavedPipeline[] {
  cache = null
  return readPipelines()
}

function persist(next: SavedPipeline[]): boolean {
  const ok = write(LIST_KEY, JSON.stringify(next))
  if (ok) {
    cache = next
    notify()
  }
  return ok
}

function cleanName(name: string): string | null {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= MAX_NAME ? trimmed : null
}

function newId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 8)
}

/** The new pipeline, and the oldest one if keeping twenty meant dropping it (I3), so the page can say so. */
export function savePipeline(name: string, graph: PipelineGraph): { saved: SavedPipeline; dropped: SavedPipeline | null } | null {
  const clean = cleanName(name)
  if (!clean) return null
  const p: SavedPipeline = { id: newId(), name: clean, graph: structuredClone(graph), savedAt: new Date().toISOString() }
  const next = [p, ...freshPipelines()]
  if (!persist(next.slice(0, MAX_PIPELINES))) return null
  setCurrentId(p.id)
  return { saved: p, dropped: next[MAX_PIPELINES] ?? null }
}

/** The line that says a save pushed the oldest pipeline out (I3). */
export const droppedText = (dropped: SavedPipeline) =>
  `Saved. ${dropped.name}, the oldest pipeline, was removed to keep ${MAX_PIPELINES}.`

/**
 * A saved graph as this server can run it, or null. Storage is per browser but
 * the registry is per server, so a pipeline saved against another server's
 * transforms (M7) is listed but never loaded.
 */
export function usableGraph(p: SavedPipeline, registry: Registry): PipelineGraph | null {
  return loadGraph(JSON.stringify(p.graph), registry)
}

export function updatePipeline(id: string, graph: PipelineGraph): boolean {
  const list = freshPipelines()
  if (!list.some((p) => p.id === id)) return false
  return persist(list.map((p) => (p.id === id ? { ...p, graph: structuredClone(graph), savedAt: new Date().toISOString() } : p)))
}

export function renamePipeline(id: string, name: string): boolean {
  const clean = cleanName(name)
  if (!clean) return false
  const list = freshPipelines()
  if (!list.some((p) => p.id === id)) return false
  return persist(list.map((p) => (p.id === id ? { ...p, name: clean } : p)))
}

export function deletePipeline(id: string): void {
  const ok = persist(freshPipelines().filter((p) => p.id !== id))
  if (ok && readCurrentId() === id) setCurrentId(null)
}

/** What an import did: new ones added, ones already here by id, and incoming ones the cap left out. */
export interface ImportResult<T> {
  added: number
  skipped: number
  /** Incoming items that did not fit under the cap, newest first. Nothing already saved is ever removed. */
  leftOut: T[]
}

/**
 * Merge `incoming` into `current` by id, for a list of at most `max`. Every
 * item already here stays: an import never removes saved work. New items go
 * in newest first while there is room, and the rest are left out and named.
 * A copy already here wins, so an import never duplicates and never overwrites.
 * `size` is how many places the current list takes (it may hold entries this
 * caller cannot read). Shared with the experiments adapter.
 */
export function mergeById<T extends { id: string; savedAt: string }>(
  currentIds: ReadonlySet<string>,
  size: number,
  incoming: T[],
  max: number,
): { add: T[]; result: ImportResult<T> } {
  const have = new Set(currentIds)
  const fresh: T[] = []
  for (const x of incoming) {
    if (have.has(x.id)) continue
    have.add(x.id)
    fresh.push(x)
  }
  fresh.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  const room = Math.max(0, max - size)
  const add = fresh.slice(0, room)
  return { add, result: { added: add.length, skipped: incoming.length - fresh.length, leftOut: fresh.slice(room) } }
}

/** Library import: add saved pipelines from a file (I3 cap, I4 fresh read). Null when storage refused the write. */
export function importPipelines(incoming: SavedPipeline[]): ImportResult<SavedPipeline> | null {
  const current = freshPipelines()
  const { add, result } = mergeById(new Set(current.map((p) => p.id)), current.length, incoming.filter(isPipeline), MAX_PIPELINES)
  const next = [...current, ...add].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  return persist(next) ? result : null
}

/** Delete every saved pipeline, and the selection with them. The working copy on Build stays. */
export function clearPipelines(): void {
  persist([])
  setCurrentId(null)
}

export function readCurrentId(): string | null {
  if (currentCache === undefined) currentCache = read(CURRENT_KEY, (raw) => raw)
  return currentCache
}

export function setCurrentId(id: string | null): void {
  currentCache = id
  write(CURRENT_KEY, id)
  notify()
}

/** Another tab changed the list or the selection: drop what this tab cached and re-read (I4). */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== LIST_KEY && e.key !== CURRENT_KEY) return
  cache = null
  currentCache = undefined
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

let snapshot: { pipelines: SavedPipeline[]; currentId: string | null } | null = null
function getSnapshot() {
  const pipelines = readPipelines()
  const currentId = readCurrentId()
  if (!snapshot || snapshot.pipelines !== pipelines || snapshot.currentId !== currentId) snapshot = { pipelines, currentId }
  return snapshot
}

export function usePipelines(): { pipelines: SavedPipeline[]; currentId: string | null } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))

export function sameGraph(a: PipelineGraph, b: PipelineGraph): boolean {
  const edges = (g: PipelineGraph) => [...g.edges].map((e) => `${e.src}>${e.dst}:${e.port}`).sort()
  return JSON.stringify(byId(a.nodes)) === JSON.stringify(byId(b.nodes)) && JSON.stringify(edges(a)) === JSON.stringify(edges(b))
}

const toBase64Url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const fromBase64Url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

export function encodePipeline(name: string, graph: PipelineGraph): string {
  return toBase64Url(JSON.stringify({ v: 1, name, graph }))
}

/** null unless the code is well formed, version 1, and every node names a transform this registry has. */
export function decodePipeline(code: string, registry: Registry): { name: string; graph: PipelineGraph } | null {
  try {
    const parsed = JSON.parse(fromBase64Url(code)) as { v?: unknown; name?: unknown; graph?: unknown }
    if (parsed.v !== 1 || typeof parsed.name !== "string") return null
    const graph = loadGraph(JSON.stringify(parsed.graph), registry)
    return graph ? { name: parsed.name, graph } : null
  } catch {
    return null
  }
}

export function resetPipelinesForTests(): void {
  cache = null
  currentCache = undefined
  snapshot = null
}
