import type { Registry } from "@/api/types"

import { documentOf, documentsOf, type DocRef } from "./document"
import type { PipelineGraph } from "./graph"
import { isUnsaved, STARTER_ID, usableGraph, type SavedPipeline } from "./pipelines"
import type { StarterPipeline } from "./starter"

/**
 * The pipelines a page can pick, pipeline first: the ready-made Starter, the
 * saved ones, and the pipeline on Build when it is not saved (new, or edited
 * since it was picked). Each carries its own documents, so a document comes
 * with the pipeline instead of the other way round.
 */

/** The value of the pipeline on Build, when it is not saved. */
export const ON_BUILD = "build"
/** The value of the Build your own action in a picker. */
export const BUILD_YOUR_OWN = "new"

export interface PipelineChoice {
  id: string
  /** The name in the picker. */
  name: string
  /** The name inside a sentence: "the pipeline on Build", "Mine (edited)". */
  label: string
  kind: "ready" | "saved" | "build"
  /** Null for a saved pipeline this server cannot run. */
  graph: PipelineGraph | null
  documents: DocRef[]
  /** Which last score this one is compared with: an edited pipeline compares with its own. */
  key: string
}

export function pipelineChoices({
  starter,
  saved,
  registry,
  working,
  currentId,
}: {
  starter: StarterPipeline | null
  saved: readonly SavedPipeline[]
  registry: Registry
  working: PipelineGraph | null
  currentId: string | null
}): PipelineChoice[] {
  const out: PipelineChoice[] = []
  if (starter) out.push({ ...starter, label: starter.name, kind: "ready", key: STARTER_ID })
  for (const p of saved) out.push({ id: p.id, name: p.name, label: p.name, kind: "saved", graph: usableGraph(p, registry), documents: p.documents, key: p.id })
  if (working && documentOf(working)) {
    const current = currentId === STARTER_ID ? starter : (saved.find((p) => p.id === currentId) ?? null)
    // The Starter on the visitor's own document is unsaved work too, even though Build does not call it edited.
    if (isUnsaved(current, working)) {
      const own = current && current.id !== STARTER_ID ? current : null
      out.push({
        id: ON_BUILD,
        name: "The pipeline on Build",
        label: own ? `${own.name} (edited)` : "the pipeline on Build",
        kind: "build",
        graph: working,
        documents: documentsOf(working),
        key: own ? own.id : "working",
      })
    }
  }
  return out
}

/**
 * The pipeline a page opens on: the one a link asks for, else the unsaved
 * pipeline on Build, else Build's own selection, else the Starter, else the
 * first saved one that can run. "" when there is none.
 */
export function defaultChoice(choices: readonly PipelineChoice[], currentId: string | null, wanted?: string | null): string {
  const runs = (id: string | null | undefined) => (id ? choices.find((c) => c.id === id && c.graph) : undefined)
  return (runs(wanted) ?? runs(ON_BUILD) ?? runs(currentId) ?? runs(STARTER_ID) ?? choices.find((c) => c.graph))?.id ?? ""
}
