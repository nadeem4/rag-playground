import { useEffect, useState } from "react"

import { api } from "@/api/client"
import type { Registry, Source } from "@/api/types"
import { useRegistry } from "@/api/useRegistry"
import { ChunkingLesson } from "@/components/learn/ChunkingLesson"
import { CitationsLesson } from "@/components/learn/CitationsLesson"
import { cn } from "@/lib/utils"
import { chatSampleGraph, storeGraph } from "@/state/graph"

import { RegistryScreen } from "./Shell"

/**
 * Learn: a list of topics and one topic at a time. Each topic works on the
 * bundled sample, registered here like an upload (idempotent).
 */

export const TOPICS = [
  { slug: "chunking", href: "/learn/chunking", label: "Chunking" },
  { slug: "citations", href: "/learn/citations", label: "How citations work" },
] as const

export type TopicSlug = (typeof TOPICS)[number]["slug"]

/** `/learn` opens the first topic; an unknown topic does too. */
export function topicFor(path: string): TopicSlug {
  const slug = path.replace(/^\/learn\/?/, "").split("/")[0]
  return TOPICS.find((t) => t.slug === slug)?.slug ?? TOPICS[0].slug
}

/** "Try it yourself": Build opens on the sample with a chat step, through the shared stored graph. */
async function openChat(registry: Registry, sample: Source | null) {
  const src = sample ?? (await api.sampleSource())
  storeGraph(chatSampleGraph(registry, src))
  window.location.assign("/")
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

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Topics" className="flex flex-row flex-wrap gap-1 md:flex-col">
          {TOPICS.map((t) => (
            <a
              key={t.slug}
              href={t.href}
              aria-current={t.slug === topic ? "page" : undefined}
              className={cn(
                "flex min-h-[28px] items-center rounded-control px-2 text-sm",
                t.slug === topic ? "bg-surface-elevated font-medium text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-4">
          {sampleError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              The sample document could not be loaded, so the lessons cannot run. {sampleError}
            </p>
          ) : null}
          {topic === "chunking" ? (
            <ChunkingLesson registry={reg.registry} sha={sample?.sha ?? null} />
          ) : (
            <CitationsLesson sha={sample?.sha ?? null} onTry={() => void openChat(reg.registry, sample)} />
          )}
        </div>
      </div>
    </main>
  )
}
