import { Button } from "@/components/ui/button"
import { barHeight, previewCaption, RUN } from "@/learn/e2e"
import { cn } from "@/lib/utils"
import { continueAction, LESSONS, useProgress, type Lesson } from "@/state/lessons"

import "@/components/learn/learn.css"

/**
 * Home: the lessons as an ordered path, the first one featured with the chunk
 * map of its recorded run, and a way out to Build for your own PDF.
 */

const REPO = "https://github.com/nadeem4/rag-playground"

/** The recorded run's chunks as bars; the top pick and the reranker's picks stand out. */
function Preview() {
  const kept = new Set(RUN.mmr)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="chunk-map h-[64px]" aria-hidden>
        {RUN.chunks.map((c) => (
          <span
            key={c.id}
            data-chunk={c.id === RUN.mmr[0] ? "top" : kept.has(c.id) ? "kept" : "rest"}
            style={{ height: barHeight(c, RUN, 22, 42) }}
          />
        ))}
      </div>
      <p className="m-0 font-mono text-xs text-fg-muted">{previewCaption(RUN)}</p>
    </div>
  )
}

function LessonRow({ lesson, n, done }: { lesson: Lesson; n: number; done: boolean }) {
  const featured = n === 1
  return (
    <li>
      <article
        aria-labelledby={`lesson-${lesson.slug}`}
        className={cn(
          "grid grid-cols-[32px_minmax(0,1fr)] items-start gap-4 rounded-panel border bg-surface-elevated p-4",
          featured ? "border-fg-muted lg:grid-cols-[40px_minmax(0,1fr)_300px] lg:p-6" : "border-hairline md:grid-cols-[40px_minmax(0,1fr)]",
        )}
      >
        <span className="pt-px font-mono text-lg text-fg-muted">{n}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`lesson-${lesson.slug}`} className={cn("m-0 font-semibold", featured ? "text-xl" : "text-lg")}>
            {lesson.title}
          </h3>
          <p className="m-0 max-w-[60ch] text-base text-fg-muted">{lesson.what}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {[...lesson.steps, lesson.size].map((s) => (
              <span key={s} className="rounded-control border border-hairline px-2 text-xs text-fg-muted">
                {s}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              <a href={lesson.href}>{done ? "Open again" : "Start"}</a>
            </Button>
            {done ? <span className="text-sm font-medium text-fg">Done</span> : null}
          </div>
        </div>
        {featured ? (
          <div className="col-span-full lg:col-span-1">
            <Preview />
          </div>
        ) : null}
      </article>
    </li>
  )
}

export function Home() {
  const done = useProgress()
  const go = continueAction(done)
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page">
        <section className="learn-top flex max-w-[680px] flex-col gap-4">
          <h1 className="learn-display">Learn how RAG works by trying it.</h1>
          <p className="learn-lead">
            Short lessons on a sample PDF. You follow a real run, predict what a setting will do, and see how citations are checked.
          </p>
          <div>
            <Button asChild className="h-[36px] px-4 text-lg">
              <a href={go.href}>{go.label}</a>
            </Button>
          </div>
        </section>

        <ol aria-label="Lessons" className="m-0 mb-6 flex list-none flex-col gap-3 p-0">
          {LESSONS.map((l, i) => (
            <LessonRow key={l.slug} lesson={l} n={i + 1} done={Boolean(done[l.slug])} />
          ))}
        </ol>

        <section aria-labelledby="own-pdf" className="learn-band grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col gap-2">
            <h2 id="own-pdf" className="learn-h2">
              Use your own PDF
            </h2>
            <p className="m-0 max-w-[56ch] text-lg text-fg-muted">
              Build lets you run every step on your own document and change any setting. Compare runs two strategies side by side.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <a href="/build">Open Build</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/compare">Compare</a>
            </Button>
          </div>
        </section>

        <footer className="flex flex-wrap justify-between gap-4 border-t border-hairline py-6 text-sm text-fg-muted">
          <span>Open source under the MIT license.</span>
          <a href={REPO} className="text-fg-muted no-underline hover:text-fg">
            github.com/nadeem4/rag-playground
          </a>
        </footer>
      </div>
    </main>
  )
}
