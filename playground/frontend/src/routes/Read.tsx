import { useRegistry } from "@/api/useRegistry"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { postsFor, type Post, type PostStage } from "@/learn/posts"
import { guideIndexFor, guideLink } from "@/state/guide"

import "@/components/learn/learn.css"

import { RegistryScreen } from "./Shell"

/**
 * Read: the owner's posts in pipeline order, each stage with a button that
 * opens Build ready to try it. Reading attached to doing; not a lesson.
 */

interface Section {
  stage: PostStage
  title: string
}

const SECTIONS: Section[] = [
  { stage: "overview", title: "Overview" },
  { stage: "source", title: "Document" },
  { stage: "parse", title: "Parse" },
  { stage: "clean", title: "Clean" },
  { stage: "chunk", title: "Chunk" },
  { stage: "index", title: "Index" },
  { stage: "retrieve", title: "Retrieve" },
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

function StageSection({ section }: { section: Section }) {
  const posts = postsFor(section.stage)
  const id = `read-${section.stage}`
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
      ) : guideIndexFor(section.stage) !== null && posts.length ? (
        <div>
          <Button asChild variant="outline">
            <a href={guideLink(section.stage)}>Try this step on Build</a>
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export function Read() {
  const reg = useRegistry()
  if (reg.kind !== "ready") return <RegistryScreen state={reg} />
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page">
        <section className="learn-top flex max-w-[680px] flex-col gap-4">
          <h1 className="learn-display">Read, then try it</h1>
          <p className="learn-lead">The posts behind each step, in pipeline order.</p>
        </section>
        {SECTIONS.map((s) => (
          <StageSection key={s.stage} section={s} />
        ))}
      </div>
      <SiteFooter />
    </main>
  )
}
