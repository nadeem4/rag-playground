import { useSyncExternalStore } from "react"

import type { Registry } from "@/api/types"

import { columnOf, goldsOf, graphToConfig, isConfigShape, otherSource, sameConfig, servedConfig, unknownStrategy, type AskQuestion, type PipelineConfig } from "./config"
import { documentsOf, sameDocuments, withDocuments, type DocRef } from "./document"
import type { PipelineGraph } from "./graph"

/**
 * Form 2 of the owner's two: saved pipelines, named copies of the pipeline on
 * Build, kept in this browser as pipeline file settings (a config) with their
 * documents and question. The working pipeline Build edits stays in its own
 * key; choosing a saved pipeline copies it into the working pipeline, and
 * "Save" copies it back. Results are cached by recipe on the server, so
 * switching costs nothing.
 *
 * Versions before part 5 kept the list as graphs under OLD_LIST_KEY. The first
 * read that finds no list under LIST_KEY converts every old item with
 * `graphToConfig` and writes the result to LIST_KEY once. An item that cannot
 * be converted is kept as it was, with the reason, and listed but never
 * opened. The conversion never writes or removes the old key. The one thing
 * that removes it is the privacy page's Delete saved pipelines, which the
 * visitor asks for (clearPipelines). Nothing but its owner's Delete removes a
 * kept item: the cap of twenty never drops one.
 */

export interface SavedPipeline {
  id: string
  name: string
  savedAt: string
  /** Null when an older version saved it and it could not be converted. */
  config: PipelineConfig | null
  /** The documents the pipeline runs on. One today. */
  documents: DocRef[]
  question: AskQuestion
  /** An item kept as an older version saved it, with why it cannot be opened. Never deleted but by its owner. */
  kept?: { graph: unknown; problem: string }
}

/** The ready-made Starter pipeline's id. Never a saved one's: those are eight characters. */
export const STARTER_ID = "starter"

export const MAX_PIPELINES = 20
export const LIST_KEY = "rag-playground:pipelines:v2"
/**
 * Where versions before part 5 kept the list, as graphs. Read once and never
 * written. Removed only when the visitor deletes every saved pipeline (clearPipelines).
 */
export const OLD_LIST_KEY = "rag-playground:pipelines:v1"
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

const NO_QUESTION: AskQuestion = { text: "", gold_answers: [] }
const OLD_NAME = "A pipeline from an older version"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const isDocRef = (d: unknown): d is DocRef =>
  typeof d === "object" && d !== null && typeof (d as DocRef).sha === "string" && (d as DocRef).sha !== "" && typeof (d as DocRef).filename === "string"

const docList = (listed: unknown): DocRef[] | null =>
  Array.isArray(listed) && listed.every(isDocRef) ? listed.map(({ sha, filename }) => ({ sha, filename })) : null

/** One item of the old list or of an old export file, converted, or kept with the reason. Never null. */
export function fromOld(raw: unknown, place: number): SavedPipeline {
  const r = isRecord(raw) ? raw : {}
  // A random suffix, so items without an id from two imports never share one.
  const id = typeof r.id === "string" && r.id ? r.id : `kept-${place + 1}-${newId()}`
  const name = typeof r.name === "string" && r.name.trim() ? r.name : OLD_NAME
  const savedAt = typeof r.savedAt === "string" ? r.savedAt : new Date(0).toISOString()
  const listed = docList(r.documents)
  const c = graphToConfig(r.graph)
  if (c.ok) {
    const own = c.pipeline.documents
    // The graph's source node is what ran: a list that disagrees with it is not trusted.
    const documents = listed && (!own[0] || listed[0]?.sha === own[0].sha) ? listed : own
    return { id, name, savedAt, config: c.pipeline.config, documents, question: c.pipeline.question }
  }
  const problem = isRecord(raw) ? c.problem : "It is not a saved pipeline."
  return { id, name, savedAt, config: null, documents: listed ?? [], question: NO_QUESTION, kept: { graph: isRecord(raw) ? (r.graph ?? raw) : raw, problem } }
}

/** One item of the new list, or of a file that holds configs; null when it is not one. */
export function asSaved(raw: unknown): SavedPipeline | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.savedAt !== "string") return null
  const documents = docList(raw.documents)
  const q: AskQuestion =
    isRecord(raw.question) && typeof raw.question.text === "string" && Array.isArray(raw.question.gold_answers)
      ? { text: raw.question.text, gold_answers: goldsOf(raw.question.gold_answers) }
      : NO_QUESTION
  if (raw.config === null && isRecord(raw.kept) && typeof raw.kept.problem === "string") {
    return { id: raw.id, name: raw.name, savedAt: raw.savedAt, config: null, documents: documents ?? [], question: q, kept: { graph: raw.kept.graph, problem: raw.kept.problem } }
  }
  if (!isConfigShape(raw.config) || !documents) return null
  return { id: raw.id, name: raw.name, savedAt: raw.savedAt, config: raw.config, documents, question: q }
}

/**
 * An incoming item of either shape: a config (asSaved), or a graph an older
 * version saved (fromOld, converted or kept). Null when it is neither.
 * `fileVersion` 1 is an export file an older version wrote: every pipeline in
 * it held a graph, so each one is converted or kept, never skipped.
 */
export function asIncoming(raw: unknown, place: number, fileVersion?: number): SavedPipeline | null {
  if (fileVersion === 1) return fromOld(raw, place)
  const saved = asSaved(raw)
  if (saved) return saved
  return isRecord(raw) && "graph" in raw ? fromOld(raw, place) : null
}

export function readPipelines(): SavedPipeline[] {
  if (cache !== null) return cache
  const current = read(LIST_KEY, (raw) => JSON.parse(raw) as unknown)
  if (Array.isArray(current)) {
    cache = current.map(asSaved).filter((p): p is SavedPipeline => p !== null)
    return cache
  }
  const old = read(OLD_LIST_KEY, (raw) => JSON.parse(raw) as unknown)
  cache = Array.isArray(old) ? old.map(fromOld) : []
  // Converted once: from now on the new key is read. When the write fails, the next read converts again.
  if (Array.isArray(old)) write(LIST_KEY, JSON.stringify(cache))
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

/**
 * The new pipeline, and the oldest one if keeping twenty meant dropping it (I3), so the page can say so.
 * `documents` defaults to the graph's own, and the graph is pointed at the first. `select: false`
 * leaves Build's selection alone (a pipeline saved on Evaluate).
 */
export function savePipeline(
  name: string,
  graph: PipelineGraph,
  opts: { documents?: DocRef[]; select?: boolean } = {},
): { saved: SavedPipeline; dropped: SavedPipeline | null } | null {
  const clean = cleanName(name)
  if (!clean) return null
  const documents = opts.documents ?? documentsOf(graph)
  const c = graphToConfig(withDocuments(graph, documents))
  if (!c.ok) return null
  const p: SavedPipeline = {
    id: newId(),
    name: clean,
    savedAt: new Date().toISOString(),
    config: structuredClone(c.pipeline.config),
    documents: structuredClone(documents),
    question: structuredClone(c.pipeline.question),
  }
  const next = [p, ...freshPipelines()]
  let dropped: SavedPipeline | null = null
  if (next.length > MAX_PIPELINES) {
    // The oldest item that is not kept goes; a kept item is never dropped (I3).
    const at = next.map((x) => !x.kept).lastIndexOf(true)
    if (at <= 0) return null
    dropped = next.splice(at, 1)[0]
  }
  if (!persist(next)) return null
  if (opts.select !== false) setCurrentId(p.id)
  return { saved: p, dropped }
}

/** Why a save was refused when every item in a full list is kept. */
export const FULL_OF_KEPT = "The list is full of older pipelines that could not be converted. Delete one in the Library to save this."

/** The list is full and every item is kept, so a save is refused rather than drop one. */
export function fullOfKept(): boolean {
  const list = freshPipelines()
  return list.length >= MAX_PIPELINES && list.every((p) => p.kept)
}

/** Why a saved pipeline cannot be opened: a kept item's own problem, else steps this server lacks. */
export function keptReason(problem: string | undefined): string {
  return problem ? `Saved by an older version, and it cannot be opened here: ${problem}` : "This server does not have every step this pipeline uses."
}

/** The line that says a save pushed the oldest pipeline out (I3). */
export const droppedText = (dropped: SavedPipeline) =>
  `Saved. ${dropped.name}, the oldest pipeline, was removed to keep ${MAX_PIPELINES}.`

/**
 * A saved pipeline as this server can run it, or null. Storage is per browser
 * but the registry is per server, so a pipeline saved against another server's
 * strategies (M7) is listed but never opened, and so is a kept item.
 */
export function usableGraph(p: Pick<SavedPipeline, "config" | "documents" | "question">, registry: Registry): PipelineGraph | null {
  if (!p.config || notHere(p.config, registry)) return null
  return columnOf({ config: p.config, documents: p.documents, question: p.question }, registry)
}

/** Why a config cannot open on this server: documents that are not uploads, or a strategy it lacks. Null when it can. */
function notHere(config: PipelineConfig, registry: Registry): string | null {
  const source = config.index.source?.use
  if (source !== undefined && source !== "upload") return otherSource(source)
  const missing = unknownStrategy(config, registry)
  return missing === null ? null : `It uses a step this server does not have: ${missing}.`
}

export function updatePipeline(id: string, graph: PipelineGraph, documents: DocRef[] = documentsOf(graph)): boolean {
  const list = freshPipelines()
  const c = graphToConfig(withDocuments(graph, documents))
  if (!c.ok || !list.some((p) => p.id === id && !p.kept)) return false
  const next = {
    config: structuredClone(c.pipeline.config),
    question: structuredClone(c.pipeline.question),
    documents: structuredClone(documents),
    savedAt: new Date().toISOString(),
  }
  return persist(list.map((p) => (p.id === id ? { ...p, ...next } : p)))
}

/**
 * Drop from a saved pipeline the settings this server does not allow (a
 * prompt, a revision, a setting Pandion no longer knows), as `servedConfig`
 * decides, once it is opened. Returns what was dropped, so the page can say so.
 */
export function cleanSavedPipeline(id: string, registry: Registry): string[] {
  const list = freshPipelines()
  const p = list.find((x) => x.id === id)
  if (!p?.config) return []
  const { config, removed } = servedConfig(p.config, registry)
  if (!removed.length || !persist(list.map((x) => (x.id === id ? { ...x, config } : x)))) return []
  return removed
}

/**
 * A sample's bytes changed, so its fingerprint did (state/document.ts). Saved
 * pipelines on the old fingerprint follow it to the current copy: only the
 * fingerprint changes, so a pipeline opened that way is not edited.
 */
export function followSample(oldSha: string, now: DocRef): void {
  const list = freshPipelines()
  if (!list.some((p) => p.documents[0]?.sha === oldSha)) return
  persist(list.map((p) => (p.documents[0]?.sha === oldSha ? { ...p, documents: [{ ...now }, ...p.documents.slice(1)] } : p)))
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
export function importPipelines(incoming: readonly unknown[]): (ImportResult<SavedPipeline> & { kept: number }) | null {
  const current = freshPipelines()
  const valid = incoming.map((raw, place) => asIncoming(raw, place)).filter((p): p is SavedPipeline => p !== null)
  const { add, result } = mergeById(new Set(current.map((p) => p.id)), current.length, valid, MAX_PIPELINES)
  const next = [...current, ...add].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  // How many of the added ones are kept, so the import can say they cannot be opened.
  return persist(next) ? { ...result, kept: add.filter((p) => p.kept).length } : null
}

/**
 * Delete every saved pipeline, and the selection with them. The working copy on
 * Build stays. The visitor asked for this, so the list an older version saved
 * goes too; the new list stays as an empty one, so nothing converts again.
 */
export function clearPipelines(): void {
  persist([])
  write(OLD_LIST_KEY, null)
  setCurrentId(null)
}

/** Whether the list an older version saved is still in this browser. */
export function oldListStored(): boolean {
  return read(OLD_LIST_KEY, (raw) => raw) !== null
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

/** What a saved pipeline or the Starter is compared by: its settings and its documents. */
type Comparable = { id: string; documents: DocRef[]; config: PipelineConfig | null }

/**
 * Whether the working copy is work no saved pipeline holds: a new pipeline, a
 * changed step, or another document, the Starter included. Evaluate lists such
 * a copy as the pipeline on Build, and nothing replaces it without a word.
 */
export function isUnsaved(p: Comparable | null, working: PipelineGraph): boolean {
  return !p || isEdited(p, working) || !sameDocuments(p.documents, documentsOf(working))
}

const toBase64Url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const fromBase64Url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

/**
 * Version 3 carries the config, the documents and the question. Versions 1 and
 * 2 carried a graph and still open: they are converted once on the way in.
 * Throws for a graph that is not a column, which the app never makes.
 */
export function encodePipeline(name: string, graph: PipelineGraph, documents: DocRef[] = documentsOf(graph)): string {
  const c = graphToConfig(withDocuments(graph, documents))
  if (!c.ok) throw new Error(c.problem)
  return toBase64Url(JSON.stringify({ v: 3, name, config: c.pipeline.config, documents, question: c.pipeline.question }))
}

/** `removed` names the settings the link carried that this server does not allow, which were dropped. */
export type Decoded = { ok: true; name: string; graph: PipelineGraph; documents: DocRef[]; removed?: string[] } | { ok: false; problem: string }

/** Null when the code is not a pipeline link; otherwise the pipeline, or why it cannot open here. */
export function decodePipeline(code: string, registry: Registry): Decoded | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(code))
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string" || ![1, 2, 3].includes(parsed.v as number)) return null
  // A version 3 link is a config, never a kept item: it cannot carry a problem sentence of its own.
  if (parsed.v === 3 && (!isRecord(parsed.config) || "kept" in parsed)) return null
  try {
    const p =
      parsed.v === 3
        ? asSaved({ id: "link", name: parsed.name, savedAt: "", config: parsed.config, documents: parsed.documents, question: parsed.question })
        : fromOld({ id: "link", name: parsed.name, savedAt: "", graph: parsed.graph, documents: parsed.v === 2 ? parsed.documents : undefined }, 0)
    if (!p) return null
    if (p.kept) return { ok: false, problem: p.kept.problem }
    const why = p.config && notHere(p.config, registry)
    if (why) return { ok: false, problem: why }
    const graph = usableGraph(p, registry)
    if (!graph || !p.config) return null
    // Drawn without the settings the server does not allow; the page says which went.
    const { removed } = servedConfig(p.config, registry)
    return { ok: true, name: parsed.name, graph, documents: p.documents, ...(removed.length ? { removed } : {}) }
  } catch {
    // A backstop: whatever a crafted link holds, it is not a link, never a crash.
    return null
  }
}

/** The same steps and settings, whatever document they run on and whatever question is typed. */
export function sameSteps(a: PipelineGraph, b: PipelineGraph): boolean {
  const x = graphToConfig(a)
  const y = graphToConfig(b)
  return x.ok && y.ok && sameConfig(x.pipeline.config, y.pipeline.config)
}

/**
 * Whether the working copy differs from the pipeline it came from. A step or
 * a setting always counts. Another document counts for a saved pipeline,
 * because it owns its documents and Save keeps the new ones. The Starter is
 * ready-made and runs on any sample, so only its steps count.
 */
export function isEdited(p: Comparable, working: PipelineGraph): boolean {
  const c = graphToConfig(working)
  if (!p.config || !c.ok || !sameConfig(p.config, c.pipeline.config)) return true
  return p.id !== STARTER_ID && !sameDocuments(p.documents, c.pipeline.documents)
}

export function resetPipelinesForTests(): void {
  cache = null
  currentCache = undefined
  snapshot = null
}
