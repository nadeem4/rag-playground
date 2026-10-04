import { useSamples } from "@/api/samples"
import type { Registry, SampleCard } from "@/api/types"
import { useRegistry } from "@/api/useRegistry"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { postsFor, type Post, type PostStage } from "@/learn/posts"
import { sampleGraph } from "@/state/graph"
import { encodePipeline } from "@/state/pipelines"

import "@/components/learn/learn.css"

import { RegistryScreen } from "./Shell"

/**
 * Read: the owner's posts in pipeline order, each stage with a button that
 * opens Build ready to try it. Reading attached to doing; not a lesson.
 */

interface Section {
  stage: PostStage
  title: string
  /** The bundled sample a stage's "Try it on Build" link loads; none means no Build button. */
  sample?: string
}

const SECTIONS: Section[] = [
  { stage: "overview", title: "Overview" },
  { stage: "source", title: "Document", sample: "two-column-report" },
  { stage: "parse", title: "Parse", sample: "two-column-report" },
  { stage: "clean", title: "Clean", sample: "chunking-primer" },
  { stage: "chunk", title: "Chunk", sample: "chunking-primer" },
  { stage: "index", title: "Index", sample: "chunking-primer" },
  { stage: "retrieve", title: "Retrieve", sample: "chunking-primer" },
  { stage: "rerank", title: "Rerank" },
  { stage: "use_case", title: "Answer" },
  { stage: "evaluate", title: "Evaluate" },
]

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** "2026-09-30" as "30 September 2026". */
function dateInWords(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * The "Try it on Build" buttons are hidden until the Guide me tour can say what the
 * reader is learning and when they have tried it (owner, 3 October). Flip this to
 * bring them back; the link builder stays tested.
 */
export const TRY_IT_ENABLED = false

/** A share link that opens Build on the stage's sample with the sample's own question, built the way the parsing lab builds one. */
export function tryLink(registry: Registry, sample: SampleCard, title: string): string {
  const graph = sampleGraph(registry, { sha: sample.sha, filename: sample.filename }, sample.question)
  return `/build?pipeline=${encodePipeline(`Read: ${title}`, graph)}`
}

function PostItem({ post }: { post: Post }) {
  return (
    <li className="flex flex-col gap-1">
      <a href={post.url} target="_blank" rel="noreferrer" className="font-serif text-lg font-medium text-fg underline-offset-2 hover:underline">
        {post.title}
      </a>
      <p className="m-0 max-w-[60ch] text-base text-fg-muted">{post.line}</p>
      <p className="m-0 text-sm text-fg-muted">{dateInWords(post.published)}</p>
    </li>
  )
}

function StageSection({ section, registry, samples }: { section: Section; registry: Registry; samples: SampleCard[] | null }) {
  const posts = postsFor(section.stage)
  const id = `read-${section.stage}`
  const sample = section.sample ? samples?.find((s) => s.name === section.sample) : undefined
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-hairline py-8">
      <h2 id={id} className="learn-h2">
        {section.title}
      </h2>
      {posts.length ? (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {posts.map((p) => (
            <PostItem key={p.url} post={p} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-base text-fg-muted">No post on this yet.</p>
      )}
      {section.stage === "evaluate" ? (
        <div>
          <Button asChild variant="outline">
            <a href="/evaluate">Open Evaluate</a>
          </Button>
        </div>
      ) : TRY_IT_ENABLED && sample && posts.length ? (
        <div>
          <Button asChild variant="outline">
            <a href={tryLink(registry, sample, section.title)}>Try it on Build</a>
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export function Read() {
  const reg = useRegistry()
  const { samples } = useSamples()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page">
        <section className="learn-top flex max-w-[680px] flex-col gap-4">
          <h1 className="learn-display">Read, then try it</h1>
          <p className="learn-lead">The posts behind each step, in pipeline order.</p>
        </section>
        {SECTIONS.map((s) => (
          <StageSection key={s.stage} section={s} registry={reg.registry} samples={samples} />
        ))}
      </div>
      <SiteFooter />
    </main>
  )
}
