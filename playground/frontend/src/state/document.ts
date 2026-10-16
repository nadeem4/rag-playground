import { useMemo, useSyncExternalStore } from "react"

import { api } from "@/api/client"
import { loadRegistry } from "@/api/useRegistry"
import { v2 } from "@/api/v2"
import { sampleQuestionTexts } from "@/api/samples"
import type { SampleCard, Source } from "@/api/types"
import { hasPages } from "@/lib/formats"

import { followSample, setCurrentId, STARTER_ID } from "./pipelines"
import { initialGraph, readStoredGraph, sampleGraph, storedGraphJson, storeGraph, subscribeGraph, type PipelineGraph } from "./graph"
import { parseWorking, readWorking, storeWorking } from "./working"

/**
 * The document every page works on. The working pipeline holds it in its
 * `documents` (state/working.ts); a graph holds it in its source node
 * (`config.sha`, `config.filename`), so saved pipelines, share links and the
 * run request keep their shape. This module reads it from the stored working
 * pipeline, so the header needs no registry, and keeps
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

/** A pipeline's documents as a list: the source node's file, or none. One today; several later. */
export function documentsOf(g: Pick<PipelineGraph, "nodes"> | null | undefined): DocRef[] {
  const doc = documentOf(g)
  return doc ? [doc] : []
}

/** The graph on these documents: its source node points at the first. With none, the graph as it is. */
export function withDocuments<G extends Pick<PipelineGraph, "nodes">>(g: G, docs: readonly DocRef[]): G {
  return docs[0] ? withDocument(g, docs[0]) : g
}

/** The same files in the same order. */
export function sameDocuments(a: readonly DocRef[], b: readonly DocRef[]): boolean {
  return a.length === b.length && a.every((d, i) => d.sha === b[i].sha)
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
  /** Every file `GET /api/v2/documents` lists: uploads plus any sample loaded. Null until it answers, and if it fails. */
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
  /** A sample's filename when its old fingerprint was swapped for the current one, until the next choice. */
  recovered: string | null
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
  recovered: null,
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
  v2.documents().then(
    (s) => {
      if (gen !== generation) return
      set(Array.isArray(s) ? { sources: s, sourcesFailed: false } : { sources: null, sourcesFailed: true })
      recoverStaleSample()
    },
    () => gen === generation && set({ sources: null, sourcesFailed: true }),
  )
}

function fetchSamples() {
  const gen = generation
  api.samples().then(
    (s) => {
      if (gen !== generation) return
      set(Array.isArray(s) ? { samples: s, samplesFailed: false } : { samples: null, samplesFailed: true })
      recoverStaleSample()
    },
    () => gen === generation && set({ samples: null, samplesFailed: true }),
  )
}

/**
 * The sample a document saved with an old fingerprint stands for, or null. A
 * sample's bytes can change (a new release, or the hour on 2026-10-05 when the
 * demo served Git LFS pointer files), so its sha changes while its filename
 * stays. A stored document carries no mark saying it was a sample, so the rule
 * is: its sha is in neither list, its filename equals a sample's exactly, and
 * no upload in this browser has that filename (an upload is never matched by
 * name). Null until both lists have answered.
 */
export function staleSample(
  doc: DocRef | null,
  sources: readonly Source[] | null,
  samples: readonly SampleCard[] | null,
  known: ReadonlySet<string>,
): SampleCard | null {
  if (!doc || !sources || !samples || known.has(doc.sha)) return null
  if (sources.some((s) => s.sha === doc.sha) || samples.some((s) => s.sha === doc.sha)) return null
  const sampleShas = new Set(samples.map((s) => s.sha))
  if (sources.some((s) => !sampleShas.has(s.sha) && s.filename === doc.filename)) return null
  return samples.find((s) => s.filename === doc.filename) ?? null
}

let recovering = false

/** Switch a working graph whose sample has an old fingerprint to that sample's current copy, and say so once. */
function recoverStaleSample(): void {
  if (recovering) return
  const old = storedDocument(storedGraphJson())
  const card = staleSample(old, state.sources, state.samples, state.known)
  if (!card || !old) return
  recovering = true
  const gen = generation
  const now = { sha: card.sha, filename: card.filename }
  // No question: only the fingerprint changes, so the query text the visitor typed stays.
  chooseDocument(now)
    .then(
      () => {
        // A saved pipeline on the old fingerprint follows too, so it does not open as edited.
        followSample(old.sha, now)
        if (gen === generation) set({ recovered: card.filename })
      },
      () => {},
    )
    .finally(() => {
      recovering = false
    })
}

// Watches the working graph, so a saved pipeline or experiment opened with an old sample fingerprint recovers too.
let unwatchGraph: (() => void) | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started) {
    started = true
    unwatchGraph = subscribeGraph(recoverStaleSample)
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

// The page button that opened the menu, so focus goes back to it when the menu closes.
let opener: HTMLElement | null = null

/** Open or close the menu. Opening it here (the control's own trigger) forgets any page opener. */
export function setDocumentMenuOpen(open: boolean): void {
  if (open) opener = null
  if (state.menuOpen !== open) set({ menuOpen: open })
}

/** The page button that opened the menu, once: it is forgotten as it is read. */
export function takeDocumentMenuOpener(): HTMLElement | null {
  const el = opener
  opener = null
  return el
}

/** One upload at a time for the whole page: what is being sent, and why the last one failed. */
export function setUploadState(patch: { uploading?: string | null; uploadError?: string | null }): void {
  set(patch)
}

/** True while an upload or a sample load runs: another pick then waits, so the two cannot race. */
export function documentBusy(): boolean {
  return state.uploading !== null || state.sampleLoading !== null
}

/** A page's "Pick a document" or "Change" button: open the page's Document control menu, and give focus back to that button when it closes. */
export function openDocumentMenu(event?: { currentTarget: EventTarget | null }): void {
  setDocumentMenuOpen(true)
  opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
}

/** The stored working pipeline's first document, without the registry. */
function storedDocument(json: string | null): DocRef | null {
  return parseWorking(json)?.documents[0] ?? null
}

/**
 * Make `doc` the working graph's document. A pipeline that already has one
 * keeps every setting; with a `question` (a sample's own) the query text is
 * set too. With no graph or no document yet, a sample gets the sample
 * pipeline and an upload the stored or default one. Nothing is stored until
 * every await has resolved, so a page left mid-way keeps the old document.
 */
export async function chooseDocument(doc: DocRef, question?: string): Promise<void> {
  set({ known: new Set(state.known).add(doc.sha), uploadError: null, recovered: null })
  const current = readWorking()
  const from = current?.documents[0]
  if (current && from) {
    // A sample's question the app filled in means nothing on another document; a typed one stays.
    // Answered at once when it can be, so a switch that needs no list waits on nothing.
    const hit = question === undefined ? isSampleQuestion(from, current.question.text, doc) : false
    const text = question ?? ((typeof hit === "boolean" ? hit : await hit) ? "" : undefined)
    storeWorking({ ...current, documents: [doc], question: text === undefined ? current.question : { ...current.question, text } })
  } else {
    const registry = await loadRegistry()
    const isSample = question !== undefined || (state.samples?.some((s) => s.sha === doc.sha) ?? false)
    storeGraph(isSample ? sampleGraph(registry, doc, question) : withDocument(readStoredGraph(registry) ?? initialGraph(registry), doc))
    // A sample with no pipeline yet gets the default recipe: that is the Starter, on this sample.
    if (isSample) setCurrentId(STARTER_ID)
  }
  setDocumentMenuOpen(false)
}

/** True when `from` is a sample other than `next` and `text` is one of that sample's own questions. */
function isSampleQuestion(from: DocRef, text: string, next: DocRef): boolean | Promise<boolean> {
  const card = state.samples?.find((c) => c.sha === from.sha)
  if (!card || card.sha === next.sha) return false
  if (!text) return false
  if (text === card.question) return true
  return sampleQuestionTexts(card.name).then((texts) => texts.includes(text))
}

/** Load a bundled sample on the server (`POST /api/sources/sample`), then make it the document with its own question. */
export async function loadSampleDocument(card: Pick<SampleCard, "name" | "question">): Promise<void> {
  // An upload or another sample is on its way: this one waits, so the two cannot race.
  if (documentBusy()) return
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
  /** True when the samples list could not be read. */
  samplesFailed: boolean
  /** The listed files that are not a sample; null until the list answers, and if it fails. */
  uploads: Source[] | null
  /** True when this browser's uploads could not be listed. */
  listError: boolean
  menuOpen: boolean
  uploading: string | null
  uploadError: string | null
  sampleLoading: string | null
  /** A one-time note when a sample saved with an old fingerprint was switched to its current copy. */
  recoveredNote: string | null
}

export function useDocument(): DocumentState {
  const json = useSyncExternalStore(subscribeGraph, storedGraphJson)
  const s = useSyncExternalStore(subscribe, getState)
  const doc = useMemo(() => storedDocument(json), [json])
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
    samplesFailed: s.samplesFailed,
    uploads,
    listError: s.sourcesFailed,
    menuOpen: s.menuOpen,
    uploading: s.uploading,
    uploadError: s.uploadError,
    sampleLoading: s.sampleLoading,
    recoveredNote: s.recovered ? `The sample ${s.recovered} was updated, so this page now uses its current copy.` : null,
  }
}

/** Whether `doc`, a page's own document rather than the working pipeline's, is usable: the same rule as the working pipeline's. */
export function useDocStatus(doc: DocRef | null): DocStatus {
  const s = useSyncExternalStore(subscribe, getState)
  return docStatus(doc, s.sources, s.samples, s.samplesFailed, s.known)
}

/**
 * Whether a document has pages to draw, by its name in the lists: a PDF does,
 * Word, a web page, Markdown, text and images do not. A document the lists do
 * not name (a sample not loaded yet) is taken as a PDF, as every sample is.
 */
export function useHasPages(): (sha: string) => boolean {
  const s = useSyncExternalStore(subscribe, getState)
  return (sha) => {
    const name = s.sources?.find((x) => x.sha === sha)?.filename
    return name === undefined || hasPages(name)
  }
}

/** Tests only: forget the lists, the files chosen and the menu, and fetch again on the next subscriber. */
export function resetDocumentForTests(): void {
  generation += 1
  started = false
  recovering = false
  unwatchGraph?.()
  unwatchGraph = null
  state = { ...FRESH, known: new Set() }
  opener = null
}
