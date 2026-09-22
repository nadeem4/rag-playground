import { useEffect, useState } from "react"

import { api } from "@/api/client"
import type { Registry, Source } from "@/api/types"
import { useRegistry } from "@/api/useRegistry"
import { ChunkingLesson } from "@/components/learn/ChunkingLesson"
import { DocumentPanel } from "@/components/learn/DocumentPanel"
import { CitationsLesson } from "@/components/learn/CitationsLesson"
import { EndToEndLesson } from "@/components/learn/EndToEndLesson"
import { chatSampleGraph, e2eSampleGraph, storeGraph, type PipelineGraph } from "@/state/graph"
import { LESSONS, type Lesson } from "@/state/lessons"

import { RegistryScreen } from "./Shell"

import "@/components/learn/learn.css"

/**
 * One lesson at a time, at /learn/<slug>. Home lists them in order. Each
 * lesson works on the bundled sample, registered here like an upload
 * (idempotent).
 */

/** The lesson a path names; an unknown one opens the first. */
export function topicFor(path: string): Lesson["slug"] {
  const slug = path.replace(/^\/learn\/?/, "").split("/")[0]
  return LESSONS.find((l) => l.slug === slug)?.slug ?? LESSONS[0].slug
}

/** Open Build on the sample with a given graph, through the shared stored graph. */
async function openBuild(sample: Source | null, make: (src: Source) => PipelineGraph) {
  const src = sample ?? (await api.sampleSource())
  storeGraph(make(src))
  window.location.assign("/build")
}

export function Learn() {
  const reg = useRegistry()
  const topic = topicFor(window.location.pathname)
  const [sample, setSample] = useState<Source | null>(null)
  const [sampleError, setSampleError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.sampleSource().then(
      (s) => live && setSample(s),
      (e: unknown) => live && setSampleError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [])

  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  const registry: Registry = reg.registry
  const build = (make: (r: Registry, src: Source) => PipelineGraph) => () => void openBuild(sample, (src) => make(registry, src))

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page flex flex-col gap-4 py-6">
        <a href="/" className="w-fit text-base font-medium text-fg underline decoration-fg-muted underline-offset-2">
          All lessons
        </a>
        {sampleError ? (
          <p role="alert" className="m-0 text-sm text-danger">
            The sample document could not be loaded, so the lessons cannot run. {sampleError}
          </p>
        ) : null}
        <DocumentPanel sha={sample?.sha ?? null} />
        {topic === "end-to-end" ? (
          <EndToEndLesson onRun={build(e2eSampleGraph)} onChat={build(chatSampleGraph)} />
        ) : topic === "chunking" ? (
          <ChunkingLesson registry={registry} sha={sample?.sha ?? null} />
        ) : (
          <CitationsLesson sha={sample?.sha ?? null} onTry={build(chatSampleGraph)} />
        )}
      </div>
    </main>
  )
}
