import { useEffect, useState, type ReactNode } from "react"
import { Popover } from "radix-ui"

import type { Stage } from "@/api/types"
import type { ExplainState } from "@/api/useExplain"
import { Button } from "@/components/ui/button"
import { postsFor } from "@/learn/posts"

/**
 * The pop-over beside a card (option B): what the step is for, how the chosen
 * transform works, what it will do with the card's current settings, the
 * trade-off, the deep-dive posts, and last the stage's lesson when it has one. Rendered inside the card's Popover.Root; Radix supplies Escape,
 * outside-click dismissal and focus return to the info button.
 */

export interface ExplainPanelProps {
  title: string
  /** The card's stage: its deep-dive posts are listed at the bottom. */
  stage: Stage
  transform: string
  what?: string
  summary?: string
  explain?: ExplainState
  /** Plan I-22: the stage's lesson paragraphs, and their heading. */
  lesson?: string[]
  lessonTitle?: string
  /** The card: interacting with it keeps the pop-over open, so settings can be edited beside it. */
  anchor: () => HTMLElement | null
}

function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={typeof label === "string" ? label : undefined} className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold">{label}</h4>
      {children}
    </section>
  )
}

const BODY = "m-0 text-sm leading-[1.55] text-fg-muted"

/** Tailwind's `sm` breakpoint: below it there is no room beside a card, so the pop-over opens below. */
const WIDE = "(min-width: 640px)"

function useWide(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE) : null)
  const [wide, setWide] = useState(() => query()?.matches ?? true)
  useEffect(() => {
    const mq = query()
    if (!mq) return
    const update = () => setWide(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return wide
}

export function ExplainPanel({ title, stage, transform, what, summary, explain, lesson, lessonTitle, anchor }: ExplainPanelProps) {
  const data = explain?.data
  const posts = postsFor(stage)
  const wide = useWide()
  const keepOpen = (e: Event) => {
    const card = anchor()
    if (card && e.target instanceof Node && card.contains(e.target)) e.preventDefault()
  }
  return (
    <Popover.Portal>
      <Popover.Content
        side={wide ? "right" : "bottom"}
        align="start"
        sideOffset={16}
        collisionPadding={16}
        aria-label={`About the ${title} step`}
        onInteractOutside={keepOpen}
        onCloseAutoFocus={(e) => {
          // Focus returns to the info button only when it would otherwise be
          // lost. When another card's pop-over replaced this one, focus is
          // already there, and moving it back would close that one.
          const active = document.activeElement
          if (active && active !== document.body) e.preventDefault()
        }}
        className="z-10 flex max-h-(--radix-popover-content-available-height) w-[400px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto gap-3 rounded-panel border border-fg-muted bg-surface p-3 text-fg"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Popover.Close asChild>
            <Button variant="outline" size="sm">
              Close
            </Button>
          </Popover.Close>
        </div>
        {what ? (
          <Part label="What this step does">
            <p className={BODY}>{what}</p>
          </Part>
        ) : null}
        {summary ? (
          <Part
            label={
              <>
                How <span className="font-mono">{transform}</span> works
              </>
            }
          >
            <p className={BODY}>{summary}</p>
          </Part>
        ) : null}
        <Part label="With your settings">
          <div aria-live="polite" className="flex flex-col gap-1">
            {explain?.invalid ? (
              <p className="m-0 text-sm leading-[1.55] whitespace-pre-wrap text-danger">These settings are not valid. {explain.invalid}</p>
            ) : data ? (
              <>
                <p className={BODY}>{data.settings}</p>
                {data.warning ? <p className="m-0 text-sm leading-[1.55] text-danger">{data.warning}</p> : null}
                {data.tradeoff ? <p className={BODY}>Trade-off: {data.tradeoff}</p> : null}
              </>
            ) : (
              <p className={BODY}>Loading</p>
            )}
          </div>
        </Part>
        {posts.length ? (
          <Part label="Read the deep dive">
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {posts.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-sm leading-[1.55] text-fg underline decoration-fg-muted underline-offset-2">
                    {p.title}
                  </a>
                </li>
              ))}
            </ul>
          </Part>
        ) : null}
        {lesson?.length ? (
          <Part label={lessonTitle ?? `What does ${title} do?`}>
            {lesson.map((p) => (
              <p key={p} className={BODY}>
                {p}
              </p>
            ))}
          </Part>
        ) : null}
      </Popover.Content>
    </Popover.Portal>
  )
}
