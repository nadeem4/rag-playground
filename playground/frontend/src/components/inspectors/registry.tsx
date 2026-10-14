import type { ComponentType } from "react"

import type { ArtifactType, ChunkSet, CleanReportEntry, ParsedDoc, RetrievalResult } from "@/api/types"

import { isChatOutput } from "./chat"
import { ChatInspector } from "./ChatInspector"
import { ChunkSetInspector } from "./ChunkSetInspector"
import { CleanReportInspector } from "./CleanReportInspector"
import type { SearchOutput } from "./hits"
import { IndexInspector, type IndexDescriptor } from "./IndexInspector"
import { JsonTreeInspector } from "./JsonTreeInspector"
import { ParsedDocInspector } from "./ParsedDocInspector"
import { RetrievalResultInspector, SearchOutputInspector } from "./RetrievalResultInspector"
import type { InspectorStatus } from "./status"

/**
 * Artifact type -> inspector. Anything unmapped falls back to the JSON tree,
 * the same escape hatch the schema form renderer has for unknown fields.
 */

export interface InspectorProps {
  data?: unknown
  status?: InspectorStatus
  /**
   * Related artifacts some inspectors can use: the pre-clean document for a
   * cleaned one, the upstream chunk set for retrieval (to place hits on it),
   * the parsed document the chunks were cut from (for "Show in PDF").
   */
  context?: { before?: ParsedDoc; chunks?: ChunkSet; doc?: ParsedDoc }
  /** False drops secondary panels (chunk metadata, the hit document). */
  showDetail?: boolean
}

function ParsedDocEntry({ data, status, context }: InspectorProps) {
  const doc = data as ParsedDoc | undefined
  const report = doc?.parser_meta?.clean_report as CleanReportEntry[] | undefined
  // A cleaned document plus the document it came from: show what was removed.
  if (report && context?.before) return <CleanReportInspector before={context.before} report={report} status={status} />
  return <ParsedDocInspector doc={doc} status={status} />
}

function ChunkSetEntry({ data, status, showDetail, context }: InspectorProps) {
  return <ChunkSetInspector chunkSet={data as ChunkSet | undefined} status={status} showDetail={showDetail} doc={context?.doc} />
}

function IndexEntry({ data, status }: InspectorProps) {
  return <IndexInspector descriptor={data as IndexDescriptor | undefined} status={status} />
}

function RetrievalEntry({ data, status, context, showDetail }: InspectorProps) {
  return <RetrievalResultInspector result={data as RetrievalResult | undefined} status={status} chunkSet={context?.chunks} showDetail={showDetail} doc={context?.doc} />
}

/**
 * A use case's output. Search results read like a retrieval result, a chat
 * answer gets its citations; anything else is shown as data.
 */
function OutputEntry(props: InspectorProps) {
  const out = props.data as SearchOutput | undefined
  const ready = !props.status || props.status.kind === "ready"
  if (ready && out?.kind === "search" && Array.isArray(out.payload?.results)) {
    return <SearchOutputInspector output={out} chunkSet={props.context?.chunks} showDetail={props.showDetail} doc={props.context?.doc} />
  }
  if (ready && isChatOutput(props.data)) {
    return <ChatInspector payload={props.data.payload} chunkSet={props.context?.chunks} />
  }
  return <JsonTreeInspector data={props.data} status={props.status} />
}

export const INSPECTORS: Partial<Record<ArtifactType, ComponentType<InspectorProps>>> = {
  parsed_doc: ParsedDocEntry,
  chunk_set: ChunkSetEntry,
  index: IndexEntry,
  retrieval_result: RetrievalEntry,
  output: OutputEntry,
}

export function inspectorFor(type: string): ComponentType<InspectorProps> {
  return INSPECTORS[type as ArtifactType] ?? JsonTreeInspector
}

export function ArtifactInspector({ type, ...props }: InspectorProps & { type: string }) {
  const Inspector = inspectorFor(type)
  return <Inspector {...props} />
}

export { JsonTreeInspector }
