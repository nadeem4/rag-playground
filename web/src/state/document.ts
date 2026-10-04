import { useMemo, useSyncExternalStore } from "react"

import { api } from "@/api/client"
import type { SampleCard, Source } from "@/api/types"

import { initialGraph, readStoredGraph, sampleGraph, storedGraphJson, storeGraph, subscribeGraph, type PipelineGraph } from "./graph"

/**
 * The document every page works on. It lives where it always has, in the
 * working graph's source node (`config.sha`, `config.filename`), so saved
 * pipelines, share links and the run request keep their shape. This module
 * reads it from the stored graph, so the header needs no registry, and keeps
 * what is known about it for one page load: this browser's uploads, the
 * samples, the files chosen on this page, and whether the menu is open.
 */

export type DocRef = { sha: string; filename: string }

export type DocStatus = "empty" | "checking" | "ready" | "missing"

/** The source node's file, or null when it has none. */
export function documentOf(g: Pick<PipelineGraph, "nodes"> | null | undefined): DocRef | null {
  const source = g?.nodes?.find((n) => n.stage === "source")
  const sha = source?.config?.sha
  if (typeof sha !== "string" || !sha) return null
  return { sha, filename: String(source?.config.filename ?? "") }
}

/** The same graph on another file: only the source node's `sha` and `filename` change. */
export function withDocument<G extends Pick<PipelineGraph, "nodes">>(g: G, doc: DocRef): G {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.stage === "source" ? { ...n, config: { ...n.config, sha: doc.sha, filename: doc.filename } } : n)),
  }
}

/**
 * Whether the document is usable. Checking until the uploads have answered
 * and the samples have answered or failed (a failed samples list counts as
 * none, M1), so a slow list never flashes a file as missing. A file chosen or
 * uploaded on this page exists on the server, so it is never flagged.
 */
export function docStatus(
  doc: DocRef | null,
  uploads: readonly Source[] | null,
  samples: readonly SampleCard[] | null,
  samplesFailed: boolean,
  known: ReadonlySet<string>,
): DocStatus {
  if (!doc) return "empty"
  if (known.has(doc.sha)) return "ready"
  if (uploads === null || (samples === null && !samplesFailed)) return "checking"
  if (uploads.some((s) => s.sha === doc.sha) || (samples?.some((s) => s.sha === doc.sha) ?? false)) return "ready"
  return "missing"
}

interface State {
  /** Every file `GET /api/sources` lists: uploads plus any sample loaded. Null until it answers, and if it fails. */
  sources: Source[] | null
  sourcesFailed: boolean
  samples: SampleCard[] | null
  samplesFailed: boolean
  known: ReadonlySet<string>
  menuOpen: boolean
  /** The file an upload is sending now, shared by the menu and the first-visit card. */
  uploading: string | null
  /** Why the last upload was refused or failed. */
  uploadError: string | null
  /** The sample being loaded now, by name. */
  sampleLoading: string | null
}

const FRESH: State = {
  sources: null,
  sourcesFailed: false,
  samples: null,
  samplesFailed: false,
  known: new Set(),
  menuOpen: false,
  uploading: null,
  uploadError: null,
  sampleLoading: null,
}

let state: State = FRESH
let started = false
// Bumped by a reset, so a list that answers after it is dropped.
let generation = 0
const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

function fetchSources() {
  const gen = generation
  api.sources().then(
    (s) => gen === generation && set(Array.isArray(s) ? { sources: s, sourcesFailed: false } : { sources: null, sourcesFailed: true }),
    () => gen === generation && set({ sources: null, sourcesFailed: true }),
  )
}

function fetchSamples() {
  const gen = generation
  api.samples().then(
    (s) => gen === generation && set(Array.isArray(s) ? { samples: s, samplesFailed: false } : { samples: null, samplesFailed: true }),
    () => gen === generation && set({ samples: null, samplesFailed: true }),
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started) {
    started = true
    fetchSources()
    fetchSamples()
  }
  return () => {
    listeners.delete(listener)
  }
}

const getState = () => state

/** List this browser's uploads again (after an upload, or the menu's Retry). A failed samples list is tried again too. */
export function refreshUploads(): void {
  if (state.sourcesFailed) set({ sourcesFailed: false })
  fetchSources()
  if (state.samplesFailed) {
    set({ samplesFailed: false })
    fetchSamples()
  }
}

export function setDocumentMenuOpen(open: boolean): void {
  if (state.menuOpen !== open) set({ menuOpen: open })
}

/** One upload at a time for the whole page: what is being sent, and why the last one failed. */
export function setUploadState(patch: { uploading?: string | null; uploadError?: string | null }): void {
  set(patch)
}

/** True while an upload or a sample load runs: another pick then waits, so the two cannot race. */
export function documentBusy(): boolean {
  return state.uploading !== null || state.sampleLoading !== null
}

/** A page's "Pick a document" button: open the header's menu. */
export function openDocumentMenu(): void {
  setDocumentMenuOpen(true)
}

/** The stored graph's raw JSON as a graph, without the registry. */
function rawGraph(json: string | null): PipelineGraph | null {
  if (!json) return null
  try {
    const g = JSON.parse(json) as PipelineGraph
    return Array.isArray(g?.nodes) && Array.isArray(g?.edges) ? g : null
  } catch {
    return null
  }
}

/**
 * Make `doc` the working graph's document. A pipeline that already has one
 * keeps every setting; with a `question` (a sample's own) the query text is
 * set too. With no graph or no document yet, a sample gets the sample
 * pipeline and an upload the stored or default one. Nothing is stored until
 * every await has resolved, so a page left mid-way keeps the old document.
 */
export async function chooseDocument(doc: DocRef, question?: string): Promise<void> {
  set({ known: new Set(state.known).add(doc.sha) })
  const current = rawGraph(storedGraphJson())
  if (current && documentOf(current)) {
    let g = withDocument(current, doc)
    if (question !== undefined) {
      g = { ...g, nodes: g.nodes.map((n) => (n.stage === "query" ? { ...n, config: { ...n.config, text: question } } : n)) }
    }
    storeGraph(g)
  } else {
    const registry = await api.registry()
    const isSample = question !== undefined || (state.samples?.some((s) => s.sha === doc.sha) ?? false)
    storeGraph(isSample ? sampleGraph(registry, doc, question) : withDocument(readStoredGraph(registry) ?? initialGraph(registry), doc))
  }
  setDocumentMenuOpen(false)
}

/** Load a bundled sample on the server (`POST /api/sources/sample`), then make it the document with its own question. */
export async function loadSampleDocument(card: Pick<SampleCard, "name" | "question">): Promise<void> {
  set({ sampleLoading: card.name })
  try {
    const src = await api.sampleSource(card.name)
    await chooseDocument({ sha: src.sha, filename: src.filename }, card.question)
    refreshUploads()
  } finally {
    set({ sampleLoading: null })
  }
}

export interface DocumentState {
  doc: DocRef | null
  status: DocStatus
  samples: SampleCard[] | null
  /** The listed files that are not a sample; null until the list answers, and if it fails. */
  uploads: Source[] | null
  /** True when this browser's uploads could not be listed. */
  listError: boolean
  menuOpen: boolean
  uploading: string | null
  uploadError: string | null
  sampleLoading: string | null
}

export function useDocument(): DocumentState {
  const json = useSyncExternalStore(subscribeGraph, storedGraphJson)
  const s = useSyncExternalStore(subscribe, getState)
  const doc = useMemo(() => documentOf(rawGraph(json)), [json])
  const uploads = useMemo(
    () => (s.sources ? s.sources.filter((x) => !(s.samples?.some((c) => c.sha === x.sha) ?? false)) : null),
    [s.sources, s.samples],
  )
  // A doc ref that keeps its identity while the file is the same.
  const sha = doc?.sha
  const filename = doc?.filename
  const stable = useMemo(() => (sha ? { sha, filename: filename ?? "" } : null), [sha, filename])
  return {
    doc: stable,
    status: docStatus(stable, s.sources, s.samples, s.samplesFailed, s.known),
    samples: s.samples,
    uploads,
    listError: s.sourcesFailed,
    menuOpen: s.menuOpen,
    uploading: s.uploading,
    uploadError: s.uploadError,
    sampleLoading: s.sampleLoading,
  }
}

/** Tests only: forget the lists, the files chosen and the menu, and fetch again on the next subscriber. */
export function resetDocumentForTests(): void {
  generation += 1
  started = false
  state = { ...FRESH, known: new Set() }
}
