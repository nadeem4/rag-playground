import type { SampleCard, Source } from "@/api/types"

import { documentOf } from "./document"
import { STAGE_VERB, type PipelineGraph } from "./graph"
import { pipelineSteps } from "./evaluate"
import { asIncomingExperiment, MAX_EXPERIMENTS, rawExperiment, type SavedExperiment } from "./libraryExperiments"
import { isPipeline, MAX_PIPELINES, type SavedPipeline } from "./pipelines"

/**
 * The Library page's arithmetic, kept pure so it is testable without a
 * browser: one list of saved pipelines and experiments, the state of each
 * one's document, and the export file's shape.
 */

export type DocRef = { sha: string; filename: string }

export type LibraryItem =
  | { kind: "pipeline"; id: string; name: string; savedAt: string; doc: DocRef | null; pipeline: SavedPipeline }
  | { kind: "experiment"; id: string; name: string; savedAt: string; doc: DocRef | null; experiment: SavedExperiment }

/** Pipelines and experiments in one list, newest first. */
export function libraryItems(pipelines: readonly SavedPipeline[], experiments: readonly SavedExperiment[]): LibraryItem[] {
  const items: LibraryItem[] = [
    ...pipelines.map((p) => ({ kind: "pipeline" as const, id: p.id, name: p.name, savedAt: p.savedAt, doc: documentOf(p.graph), pipeline: p })),
    ...experiments.map((e) => ({ kind: "experiment" as const, id: e.id, name: e.name, savedAt: e.savedAt, doc: e.doc, experiment: e })),
  ]
  return items.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** A pipeline's steps by their plain names, in column order: "Docling, Recursive (natural breaks), Hybrid (RRF)". */
export function pipelineSummary(graph: PipelineGraph): string {
  return pipelineSteps(graph)
    .filter((s) => s.label !== "Index")
    .map((s) => s.name)
    .join(", ")
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "Chunk, 5 recipes". */
export function experimentSummary(e: SavedExperiment): string {
  const step = STAGE_VERB[e.stage as keyof typeof STAGE_VERB] ?? e.stage
  return `${step}, ${plural(e.recipes.length, "recipe")}`
}

/** "Saved 3 hours ago". */
export function savedWhen(savedAt: string, now: number): string {
  const t = Date.parse(savedAt)
  if (Number.isNaN(t)) return "Saved at an unknown time"
  const hours = Math.round((now - t) / 3_600_000)
  if (hours < 1) return "Saved just now"
  if (hours < 24) return `Saved ${plural(hours, "hour")} ago`
  return `Saved ${plural(Math.round(hours / 24), "day")} ago`
}

// ------------------------------------------------------------- documents --

/** An upload with fewer hours than this left on the demo gets the warning. */
export const SOON_HOURS = 6

export type DocState =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "sample" }
  | { kind: "local" }
  | { kind: "upload"; hoursLeft: number | null }
  | { kind: "gone" }

export interface DocContext {
  demo: boolean
  /** The demo's upload lifetime (`limits.ttl_hours`). */
  ttlHours: number
  now: number
  /** `GET /api/sources`; null until it answers. */
  sources: readonly Source[] | null
  /** `GET /api/samples`; null until it answers, an empty list if it failed. */
  samples: readonly Pick<SampleCard, "sha">[] | null
}

/** Where a saved item's document stands: a sample, an upload and its hours left, on this machine, or gone. */
export function docState(doc: DocRef | null, ctx: DocContext): DocState {
  if (!doc) return { kind: "none" }
  if (ctx.samples === null || ctx.sources === null) return { kind: "checking" }
  if (ctx.samples.some((s) => s.sha === doc.sha)) return { kind: "sample" }
  const listed = ctx.sources.find((s) => s.sha === doc.sha)
  if (!listed) return { kind: "gone" }
  if (!ctx.demo) return { kind: "local" }
  const at = listed.uploaded_at ? Date.parse(listed.uploaded_at) : NaN
  if (Number.isNaN(at)) return { kind: "upload", hoursLeft: null }
  const left = ctx.ttlHours - (ctx.now - at) / 3_600_000
  return { kind: "upload", hoursLeft: Math.max(0, Math.ceil(left)) }
}

export const isSoon = (s: DocState) => s.kind === "upload" && s.hoursLeft !== null && s.hoursLeft < SOON_HOURS

/** Each upload the items use, once. A sample is always on the server, so it is never one. */
export function uploadsOf(items: readonly LibraryItem[], samples: readonly Pick<SampleCard, "sha">[] | null): DocRef[] {
  const seen = new Map<string, DocRef>()
  for (const i of items) {
    if (i.doc && !samples?.some((s) => s.sha === i.doc!.sha) && !seen.has(i.doc.sha)) seen.set(i.doc.sha, i.doc)
  }
  return [...seen.values()]
}

// ------------------------------------------------------- export, import --

export const FORMAT = "rag-playground-library"
export const VERSION = 1

export interface ExportedDocument {
  sha: string
  filename: string
  pdfBase64: string
}

export type ExportedItem = ({ kind: "pipeline" } & SavedPipeline) | ({ kind: "experiment" } & SavedExperiment)

export interface LibraryFile {
  format: typeof FORMAT
  version: typeof VERSION
  exportedAt: string
  items: ExportedItem[]
  documents: ExportedDocument[]
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item"

/** `rag-playground-<name>.ragplayground.json`: the item's name for one, the date for several. */
export function exportFileName(items: readonly Pick<LibraryItem, "name">[], now: number): string {
  const name = items.length === 1 ? slug(items[0].name) : `library-${new Date(now).toISOString().slice(0, 10)}`
  return `rag-playground-${name}.ragplayground.json`
}

export function buildExport(items: readonly LibraryItem[], documents: ExportedDocument[], now: number): LibraryFile {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date(now).toISOString(),
    items: items.map((i) => (i.kind === "pipeline" ? { kind: "pipeline" as const, ...i.pipeline } : ({ kind: "experiment" as const, ...rawExperiment(i.experiment) } as ExportedItem))),
    documents,
  }
}

export type ParsedImport =
  | { ok: true; pipelines: SavedPipeline[]; experiments: SavedExperiment[]; documents: ExportedDocument[]; skipped: number }
  | { ok: false; error: string }

const NOT_OURS = "This is not a RAG Playground file. Export from Library makes one."
const SHA = /^[0-9a-f]{64}$/

const isDocument = (d: unknown): d is ExportedDocument =>
  typeof d === "object" && d !== null &&
  typeof (d as ExportedDocument).sha === "string" && SHA.test((d as ExportedDocument).sha) &&
  typeof (d as ExportedDocument).filename === "string" && typeof (d as ExportedDocument).pdfBase64 === "string"

/** A file's text as saved items and documents. Anything it cannot read is skipped and counted. */
export function parseImport(text: string): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: NOT_OURS }
  }
  if (typeof data !== "object" || data === null || (data as LibraryFile).format !== FORMAT) return { ok: false, error: NOT_OURS }
  const file = data as Partial<LibraryFile> & { version?: unknown }
  if (typeof file.version === "number" && file.version > VERSION) {
    return { ok: false, error: "This file was made by a newer RAG Playground. Update this copy to import it." }
  }
  if (file.version !== VERSION || !Array.isArray(file.items)) return { ok: false, error: NOT_OURS }
  const pipelines: SavedPipeline[] = []
  const experiments: SavedExperiment[] = []
  let skipped = 0
  for (const raw of file.items as unknown[]) {
    const item = raw as { kind?: unknown } | null
    if (item?.kind === "pipeline" && isPipeline(item)) {
      const { id, name, graph, savedAt } = item as SavedPipeline
      pipelines.push({ id, name, graph, savedAt })
      continue
    }
    if (item?.kind === "experiment" && asIncomingExperiment(item)) {
      // Kept as it came, so fields Compare added survive the round trip.
      const { kind: _kind, ...rest } = item as Record<string, unknown>
      experiments.push(rest as unknown as SavedExperiment)
    } else skipped += 1
  }
  const docs = Array.isArray(file.documents) ? (file.documents as unknown[]) : []
  const documents = docs.filter(isDocument).map(({ sha, filename, pdfBase64 }) => ({ sha, filename, pdfBase64 }))
  return { ok: true, pipelines, experiments, documents, skipped }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** "a", "a and b", "a, b and c". */
export function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("")
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

export interface ImportOutcome {
  fileName: string
  pipelines: number
  experiments: number
  /** Items the browser already had, by id. */
  already: number
  /** Incoming names each kind's cap left out. Nothing saved is ever removed. */
  leftOutPipelines: string[]
  leftOutExperiments: string[]
  /** Items in the file that are not a pipeline or an experiment this copy can read. */
  unreadable: number
  /** Documents uploaded back to the server. */
  restored: string[]
  /** Documents the server refused, with its reason. */
  refused: { filename: string; reason: string }[]
  /** Documents whose bytes in the file could not be decoded. */
  damaged: string[]
  /** Documents that uploaded, but under another fingerprint than the file names. */
  mismatched: string[]
}

function leftOutLine(names: readonly string[], word: string, max: number): string {
  if (!names.length) return ""
  return `Left out ${plural(names.length, word)}, because this browser keeps at most ${max} ${word}s and never removes saved ones: ${listWords(names)}.`
}

/** The one plain line an import ends with. */
export function importResultLine(o: ImportOutcome): string {
  const added = [o.pipelines ? plural(o.pipelines, "pipeline") : "", o.experiments ? plural(o.experiments, "experiment") : ""].filter(Boolean)
  const parts: string[] = []
  if (added.length) {
    parts.push(`Imported ${listWords(added)} from ${o.fileName}.`)
    if (o.already) parts.push(o.already === 1 ? "1 item was already here." : `${o.already} items were already here.`)
  } else if (o.already) {
    parts.push(`Nothing new in ${o.fileName}. You already have ${o.already === 1 ? "the 1 item" : `all ${o.already} items`} in it.`)
  } else {
    parts.push(`${o.fileName} has no saved items in it.`)
  }
  parts.push(leftOutLine(o.leftOutPipelines, "pipeline", MAX_PIPELINES), leftOutLine(o.leftOutExperiments, "experiment", MAX_EXPERIMENTS))
  if (o.unreadable) parts.push(`Skipped ${plural(o.unreadable, "item")} that ${o.unreadable === 1 ? "is" : "are"} not a pipeline or an experiment.`)
  if (o.restored.length) parts.push(`${listWords(o.restored)} ${o.restored.length === 1 ? "is" : "are"} back on the server.`)
  for (const r of o.refused) parts.push(`${r.filename} was not uploaded: ${sentence(r.reason)}`)
  for (const f of o.damaged) parts.push(`${f}: the document in the file is damaged.`)
  for (const f of o.mismatched) parts.push(`${f} was uploaded, but it is not the document the file names, so saved items may still ask for it.`)
  return parts.filter(Boolean).join(" ")
}
