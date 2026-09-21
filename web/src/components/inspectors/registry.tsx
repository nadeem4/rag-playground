import type { ComponentType } from "react"

import type { ArtifactType, ChunkSet, CleanReportEntry, ParsedDoc } from "@/api/types"

import { ChunkSetInspector } from "./ChunkSetInspector"
import { CleanReportInspector } from "./CleanReportInspector"
import { JsonTreeInspector } from "./JsonTreeInspector"
import { ParsedDocInspector } from "./ParsedDocInspector"
import type { InspectorStatus } from "./status"

/**
 * Artifact type -> inspector. Anything unmapped falls back to the JSON tree,
 * the same escape hatch the schema form renderer has for unknown fields.
 */

export interface InspectorProps {
  data?: unknown
  status?: InspectorStatus
  /** Related artifacts some inspectors can use; e.g. the pre-clean document. */
  context?: { before?: ParsedDoc }
}

function ParsedDocEntry({ data, status, context }: InspectorProps) {
  const doc = data as ParsedDoc | undefined
  const report = doc?.parser_meta?.clean_report as CleanReportEntry[] | undefined
  // A cleaned document plus the document it came from: show what was removed.
  if (report && context?.before) return <CleanReportInspector before={context.before} report={report} status={status} />
  return <ParsedDocInspector doc={doc} status={status} />
}

function ChunkSetEntry({ data, status }: InspectorProps) {
  return <ChunkSetInspector chunkSet={data as ChunkSet | undefined} status={status} />
}

export const INSPECTORS: Partial<Record<ArtifactType, ComponentType<InspectorProps>>> = {
  parsed_doc: ParsedDocEntry,
  chunk_set: ChunkSetEntry,
}

export function inspectorFor(type: string): ComponentType<InspectorProps> {
  return INSPECTORS[type as ArtifactType] ?? JsonTreeInspector
}

export function ArtifactInspector({ type, ...props }: InspectorProps & { type: string }) {
  const Inspector = inspectorFor(type)
  return <Inspector {...props} />
}

export { JsonTreeInspector }
