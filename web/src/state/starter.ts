import { useMemo } from "react"

import type { Registry, SampleCard } from "@/api/types"

import { graphToConfig, type PipelineConfig } from "./config"
import { useDocument } from "./document"
import { sampleGraph, type PipelineGraph } from "./graph"
import { STARTER_ID, type SavedPipeline } from "./pipelines"

/**
 * The Starter pipeline: always there, read-only, and ready to run. It is the
 * app's default recipe (`sampleGraph`: Docling, Remove duplicate blocks,
 * Recursive at 400 with 80 overlap, LanceDB with Qwen3, Hybrid RRF, no rerank,
 * no rewrite) on the default sample, A primer on chunking. It is built from the
 * samples list, so it exists once the server has answered.
 */

export const STARTER_NAME = "Starter pipeline"

/**
 * `config` is null only on a server whose default column is not a pipeline
 * file (it has no search strategy): the Starter is still listed, and pages say
 * what it lacks.
 */
export type StarterPipeline = Pick<SavedPipeline, "id" | "name" | "documents"> & { graph: PipelineGraph; config: PipelineConfig | null }

/** The sample marked default, else the first; null when there are none. */
export function defaultSample(samples: readonly SampleCard[] | null): SampleCard | null {
  return samples?.find((s) => s.default) ?? samples?.[0] ?? null
}

/** The Starter on the default sample, or on the sample called `name`. Null with no samples. */
export function starterPipeline(registry: Registry, samples: readonly SampleCard[] | null, name?: string): StarterPipeline | null {
  const card = (name ? samples?.find((s) => s.name === name) : undefined) ?? defaultSample(samples)
  if (!card) return null
  const doc = { sha: card.sha, filename: card.filename }
  const graph = sampleGraph(registry, doc, card.question)
  const c = graphToConfig(graph)
  return { id: STARTER_ID, name: STARTER_NAME, graph, config: c.ok ? c.pipeline.config : null, documents: [doc] }
}

/**
 * The Starter, once the samples list has answered, with the samples it can
 * open on. `unavailable` when there will be none: the list could not be read,
 * or it has no sample.
 */
export function useStarter(registry: Registry): { starter: StarterPipeline | null; samples: SampleCard[] | null; unavailable: boolean } {
  const { samples, samplesFailed } = useDocument()
  const starter = useMemo(() => starterPipeline(registry, samples), [registry, samples])
  return { starter, samples, unavailable: samplesFailed || (samples !== null && starter === null) }
}

const PLANTED = "designed to miss"

/**
 * "2 questions are planted to miss. Open them after the run to see why." when
 * the set has questions tagged "designed to miss"; null when it has none.
 */
export function plantedLine(questions: readonly { tags: readonly string[] }[]): string | null {
  const n = questions.filter((q) => q.tags.some((t) => t.startsWith(PLANTED))).length
  if (!n) return null
  if (n === 1) return "1 question is planted to miss. Open it after the run to see why."
  return `${n === questions.length ? "All " : ""}${n} questions are planted to miss. Open them after the run to see why.`
}
