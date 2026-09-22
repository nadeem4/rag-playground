import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Lesson } from "@/state/lessons"

import { DocumentPanel } from "./DocumentPanel"
import { LessonEnd } from "./LessonEnd"

/**
 * The shape every lesson takes: a list of steps, the step you are on, and the
 * document beside it. The shell adds a recap step at the end of every lesson,
 * so each one closes the same way.
 *
 * Where the three parts sit is set in learn.css. From 1200px they are three
 * columns. Between 900px and 1200px the step list becomes a bar above the other
 * two. Below 900px there is one column, and the Lesson and Document tabs choose
 * which of the two you see.
 *
 * Which step you are on is not remembered between visits. Finishing a lesson
 * is, through `LessonEnd`.
 */

export interface LessonStep {
  id: string
  /** Short enough to read in the step list. */
  title: string
  /** The sentence of the document this step is about, marked in the document panel. */
  sentence?: string | null
  body: ReactNode
}

export interface LessonShellProps {
  title: string
  slug: Lesson["slug"]
  /** The sample's sha, for the document panel. */
  sha: string | null
  steps: LessonStep[]
  step: number
  onStep: (next: number) => void
  /** Three or four short lines: what the lesson showed. */
  recap: string[]
  /** Shown under the title, before the first step. */
  intro?: ReactNode
}

type Pane = "lesson" | "document"
const PANES: Pane[] = ["lesson", "document"]

export function LessonShell({ title, slug, sha, steps, step, onStep, recap, intro }: LessonShellProps) {
  const [pane, setPane] = useState<Pane>("lesson")

  const all: LessonStep[] = [
    ...steps,
    {
      id: "recap",
      title: "Recap",
      body: (
        <div className="flex flex-col gap-4">
          <ul className="m-0 flex max-w-[68ch] flex-col gap-2 pl-4 text-base leading-[1.65]">
            {recap.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <LessonEnd slug={slug} />
        </div>
      ),
    },
  ]
  const i = Math.min(Math.max(step, 0), all.length - 1)
  const current = all[i]

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex max-w-[68ch] flex-col gap-2">
        <h1 className="learn-title">{title}</h1>
        {intro}
      </header>

      <div className="lesson-shell" data-pane={pane}>
        <div role="tablist" aria-label="Panes" className="lesson-panes">
          {PANES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={cn(
                "h-control rounded-control border px-2 text-xs",
                pane === p ? "border-fg bg-fg text-surface" : "border-hairline bg-surface text-fg-muted hover:text-fg",
              )}
            >
              {p === "lesson" ? "Lesson" : "Document"}
            </button>
          ))}
        </div>

        <nav aria-label="Steps" className="lesson-rail">
          <ol className="lesson-rail-list">
            {all.map((s, k) => (
              <li key={s.id} className="min-w-0">
                <button
                  type="button"
                  aria-current={k === i ? "step" : undefined}
                  onClick={() => onStep(k)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-control border px-2 py-1 text-left text-xs",
                    k === i
                      ? "border-fg bg-fg text-surface"
                      : k < i
                        ? "border-hairline bg-surface text-fg"
                        : "border-hairline bg-surface text-fg-muted hover:text-fg",
                  )}
                >
                  <span className="font-mono text-2xs">{k + 1}</span>
                  <span className="min-w-0">{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section aria-label="The step" className="lesson-main flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="m-0 text-xs text-fg-muted">
              Step {i + 1} of {all.length}
            </p>
            <h2 className="m-0 text-xl font-semibold">{current.title}</h2>
          </div>
          <div className="flex min-w-0 flex-col gap-4">{current.body}</div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-4">
            <Button variant="outline" disabled={i === 0} onClick={() => onStep(i - 1)}>
              Back
            </Button>
            <Button variant="outline" disabled={i === all.length - 1} onClick={() => onStep(i + 1)}>
              Next step
            </Button>
          </div>
        </section>

        <div className="lesson-doc min-w-0">
          <DocumentPanel sha={sha} highlight={current.sentence ?? null} />
        </div>
      </div>
    </article>
  )
}
