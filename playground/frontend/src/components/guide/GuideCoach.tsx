import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { fill, GUIDE_STEPS, type GuideStep } from "@/state/guide"

export interface GuideCoachProps {
  index: number
  question: string
  step: GuideStep
  values: Record<string, string>
  state: "ready" | "running" | "done" | "blocked"
  result: string | null
  /** A failed run's own error line; shown while the step stays ready. */
  error?: string | null
  blockedReason?: string
  onRun: () => void
  onNext: () => void
  onLeave: () => void
  extra?: ReactNode
}

/** The coach column of the guided run: one step at a time, with the pinned question. */
export function GuideCoach({
  index,
  question,
  step,
  values,
  state,
  result,
  error,
  blockedReason,
  onRun,
  onNext,
  onLeave,
  extra,
}: GuideCoachProps) {
  const total = GUIDE_STEPS.length
  const last = index === total - 1
  const done = state === "done"
  return (
    <aside
      aria-label="Guided run"
      className="guide-coach flex min-w-0 max-h-full flex-col gap-3 overflow-y-auto rounded-panel border border-primary bg-surface-raised p-4 shadow-raised"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="m-0 whitespace-nowrap text-xs font-medium text-muted-foreground">
          {`Guided run · step ${index + 1} of ${total}`}
        </p>
        <button type="button" onClick={onLeave} className="cursor-pointer bg-transparent p-0 text-xs text-muted-foreground underline hover:text-fg">
          Leave the guided run
        </button>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {GUIDE_STEPS.map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${i < index ? "bg-primary/50" : i === index ? "bg-primary" : "bg-border"}`}
          />
        ))}
      </div>
      <div className="rounded-control border border-border bg-accent-wash p-3">
        <p className="m-0 text-xs font-medium text-muted-foreground">Our question</p>
        <p className="m-0 mt-1 text-sm text-fg">{question}</p>
      </div>
      <h2 className="m-0 text-base font-semibold text-fg">{fill(step.title, values)}</h2>
      <p className="m-0 text-sm text-muted-foreground">{fill(step.body, values)}</p>
      <div className="flex flex-col items-start gap-2">
        <Button onClick={onRun} disabled={state === "running" || state === "blocked"}>
          {step.run}
        </Button>
        {state === "blocked" && blockedReason ? (
          <p className="m-0 text-xs text-muted-foreground">{blockedReason}</p>
        ) : null}
      </div>
      <div
        role="status"
        aria-live="polite"
        className={
          done && result
            ? "rounded-control border border-border bg-surface p-2 font-mono text-xs text-fg"
            : "text-sm text-danger empty:hidden"
        }
      >
        {done ? result : state === "ready" ? error : null}
      </div>
      {done ? (
        <>
          <p className="m-0 border-l-2 border-primary pl-3 text-sm text-fg">
            <strong>Why:</strong> {fill(step.why, values)}
          </p>
          <Button className="self-start" onClick={onNext}>
            {last ? "Finish" : "Next step"}
          </Button>
        </>
      ) : null}
      {extra}
    </aside>
  )
}
