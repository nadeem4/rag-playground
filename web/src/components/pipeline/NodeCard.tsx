import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Info, X } from "lucide-react"
import { Popover } from "radix-ui"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { GraphNode, TransformInfo } from "@/api/types"
import type { ExplainState } from "@/api/useExplain"
import type { FieldErrors } from "@/components/fields/schema"
import { KeyHint } from "@/components/ApiKeyControl"
import { LearnHint, StageLesson } from "@/components/learn/LearnHint"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { strategyLabel } from "@/learn/challenges"
import { cn } from "@/lib/utils"
import { STAGE_VERB } from "@/state/graph"
import { errorHeadline } from "@/state/pipeline"

import { ExplainPanel } from "./ExplainPanel"
import { lockOf, TransformSelect } from "./TransformSelect"
import { outcomeText } from "./outcome"
import { useOutcome } from "./useOutcome"
import { MonoNumbers, WhatItDid } from "./WhatItDid"

/**
 * One node of the pipeline column (foundation spec section 7). A 10 px status
 * ring before the step name shows the card's look without reading a word:
 * grey when not run, half accent while running (with a pulsing top edge),
 * accent when done, amber when the settings changed since the run, danger
 * when it failed. Under the name: the transform's plain name and code name,
 * then the result in one line. The options open below when the card is
 * selected, and the selected card is the one raised card.
 */

export interface NodeCardProps {
  node: GraphNode
  title: string
  transforms: TransformInfo[]
  result?: NodeState
  /** The result belongs to an older config of this node or an ancestor. */
  stale?: boolean
  selected: boolean
  /** A run is in flight; Run buttons are disabled. */
  busy: boolean
  fieldErrors?: FieldErrors
  message?: string
  onSelect: () => void
  onTransform: (name: string) => void
  onConfig: (config: Record<string, unknown>) => void
  onRun: (force: boolean) => void
  onRemove?: () => void
  /** Replaces the schema form (the Load card's source picker). */
  body?: ReactNode
  /** Show the node id beside the title: stacked cards need telling apart. */
  showId?: boolean
  /** Extra actions in the footer (Sweep). */
  actions?: ReactNode
  /** Plan I-12: this card's explanation for its CURRENT settings. */
  explain?: ExplainState
  /** Plan I-12: what this stage is for. */
  what?: string
  /** The explanation pop-over; the column keeps one open at a time. */
  explainOpen?: boolean
  onExplainOpenChange?: (open: boolean) => void
  /** Title of the card (this one or an ancestor) whose settings block a run. */
  blockedBy?: string
  /** This card's previous run's artifact, for "(was N)". */
  previousArtifactId?: string
  /** Plan I-22: this stage's lesson paragraphs, when the server has them. */
  lesson?: string[]
  /** The transform wired into each of this node's input ports, for lock states. */
  upstream?: Record<string, TransformInfo | undefined>
}

/** The heading of a stage's lesson. Stages without one here get a plain question. */
const LESSON_TITLE: Partial<Record<string, string>> = { chunk: "What is chunking?" }

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return ""
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 10) return `${Math.round(ms)} ms`
  return `${ms.toFixed(1)} ms`
}

export type Look = "idle" | "running" | "done" | "stale" | "failed"

type Shown = { label: string; look: Look; duration?: number }

export function describeResult(result: NodeState | undefined, stale: boolean | undefined): Shown {
  if (!result) return { label: "not run", look: "idle" }
  switch (result.status) {
    case "running":
      return { label: "running", look: "running" }
    case "failed":
      return { label: "failed", look: "failed" }
    case "skipped":
      return { label: "skipped", look: "idle" }
    case "done":
      return stale ? { label: "changed, run again", look: "stale" } : { label: "computed", look: "done", duration: result.duration_ms }
    case "cached":
      return stale
        ? { label: "changed, run again", look: "stale" }
        : { label: "reused from an earlier run", look: "done", duration: result.duration_ms }
    default:
      return { label: "not run", look: "idle" }
  }
}

/** The status ring's stroke and fill per look. */
const RING: Record<Look, string> = {
  idle: "border-hairline",
  running: "border-primary/50 bg-primary/50",
  done: "border-primary bg-primary",
  stale: "border-stale",
  failed: "border-danger",
}

/** "Recursive (natural breaks)" for `recursive_character`; the code name alone when it has no plain name. */
export function plainName(name: string): string {
  return strategyLabel(name)
}

/** The picker's option: the plain name, then the code name, as on the card. */
export function transformLabel(name: string): string {
  const plain = plainName(name)
  return plain === name ? name : `${plain}, ${name}`
}

/**
 * Whole seconds since `startedAt` (epoch seconds), ticking once a second while
 * `startedAt` is set. Feedback for a long parse, not decoration: no animation.
 */
export function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [startedAt])
  if (startedAt === undefined) return undefined
  return Math.max(0, Math.floor(now / 1000 - startedAt))
}

export function NodeCard(p: NodeCardProps) {
  const id = useId()
  // The Upload card is deliberately plain: no run status, no explain button,
  // no transform picker and no footer. It is just "pick or upload a file".
  const isSource = p.node.stage === "source"
  const info = p.transforms.find((t) => t.name === p.node.transform)
  // The picker tags locked options; the run note needs the current pick's lock too.
  const lock = lockOf(p.transforms, p.node.transform, p.upstream ?? {})
  const shown = describeResult(p.result, p.stale)
  const failed = p.result?.status === "failed" && !p.stale ? p.result.error : undefined
  const hasOutput = (p.result?.status === "done" || p.result?.status === "cached") && !p.stale
  const running = p.result?.status === "running" && !p.stale
  const elapsed = useElapsed(running ? p.result?.started_at : undefined)
  const cardRef = useRef<HTMLElement>(null)
  const warning = p.explain?.data?.warning
  const completed = (p.result?.status === "done" || p.result?.status === "cached") && p.result.artifact_id ? p.result.artifact_id : undefined
  const reused = shown.look === "done" && p.result?.status === "cached"
  // The summary row: a fresh result's outcome in one line, without "(was N)".
  const outcome = useOutcome(p.node.stage, info?.output, shown.look === "done" && !reused ? completed : undefined)
  const summary = reused
    ? "reused from an earlier run"
    : outcome?.kind === "ready" && outcome.outcome
      ? outcomeText(outcome.outcome)
      : null
  // Open with the selection; a card with an error to show opens too.
  const open = p.selected || Boolean(p.message) || Object.keys(p.fieldErrors ?? {}).length > 0
  const plain = plainName(p.node.transform)
  // A missing file is the first step, not a mistake: say it calmly (muted).
  const needsFile = p.blockedBy === STAGE_VERB.source
  const runNote = p.blockedBy
    ? needsFile
      ? "Load a sample to start."
      : p.blockedBy === p.title
        ? lock.kind === "hard"
          ? "Locked. Pick another transform to run."
          : "Fix the settings to run."
        : `Fix the ${p.blockedBy} settings to run.`
    : completed && p.stale
      ? "Settings changed since the last run."
      : null

  const filename = isSource && typeof p.node.config.filename === "string" ? p.node.config.filename : ""

  return (
    <Popover.Root open={p.explainOpen} onOpenChange={p.onExplainOpenChange}>
    <Popover.Anchor asChild>
    <article
      ref={cardRef}
      aria-label={`${p.title} ${p.node.transform}`}
      data-node-id={p.node.id}
      data-look={isSource ? undefined : shown.look}
      aria-current={p.selected ? "true" : undefined}
      onClick={p.onSelect}
      className={cn(
        "relative flex min-w-0 flex-col p-3",
        // The one raised card sits above its neighbours so they do not cover its shadow.
        p.selected ? "z-10 bg-surface-raised shadow-raised" : "bg-surface-elevated",
        p.explainOpen && "outline-1 -outline-offset-1 outline-fg-muted outline-solid",
      )}
    >
      {shown.look === "running" && !isSource ? (
        <span aria-hidden data-testid="running-bar" className="step-running-edge pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-primary" />
      ) : null}
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <h3 className="text-sm font-semibold">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-options`}
              className="flex min-h-row-compact items-center gap-2 rounded-control text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
            >
              {isSource ? null : (
                <span aria-hidden data-testid="status-ring" className={cn("size-[10px] shrink-0 rounded-full border-2", RING[shown.look])} />
              )}
              {p.title}
            </button>
          </h3>
          {p.showId ? <span className="font-mono text-xs break-all text-fg-muted">{p.node.id}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2" aria-live="polite">
          {isSource ? null : (
            <>
              {shown.look === "done" ? null : (
                <span
                  data-testid="status-chip"
                  className={cn(
                    "rounded-full px-2 text-2xs",
                    shown.look === "stale" ? "bg-stale-wash text-stale" : shown.look === "failed" ? "text-danger" : "text-fg-muted",
                  )}
                >
                  {shown.label}
                </span>
              )}
              {elapsed !== undefined ? (
                <span className="font-mono text-xs text-fg" title="Elapsed since this node started">
                  {elapsed} s
                </span>
              ) : null}
              {shown.duration !== undefined ? <span className="font-mono text-xs text-fg">{fmtMs(shown.duration)}</span> : null}
              <Popover.Trigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Explain the ${p.title} step`}
                  title={`Explain the ${p.title} step`}
                  className={cn(p.explainOpen && "border-fg-muted bg-surface-elevated")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Info aria-hidden strokeWidth={1.75} className="size-[16px]" />
                </Button>
              </Popover.Trigger>
            </>
          )}
          {p.onRemove ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-row-compact w-[24px]"
              aria-label={`Remove ${p.node.id}`}
              title="Remove this step"
              onClick={(e) => {
                e.stopPropagation()
                p.onRemove!()
              }}
            >
              <X aria-hidden strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </header>

      {isSource ? (
        filename ? <p className="m-0 text-xs break-words text-fg-muted">{filename}</p> : null
      ) : (
        <p data-testid="step-transform" className="m-0 text-xs break-words text-fg-muted">
          {plain === p.node.transform ? null : `${plain}, `}
          <span className="font-mono text-2xs">{p.node.transform}</span>
        </p>
      )}

      {summary && !isSource ? (
        <p data-testid="step-summary" className="m-0 mt-1 text-sm break-words text-fg">
          <MonoNumbers text={summary} />
        </p>
      ) : null}

      {warning ? (
        <p role="status" data-testid="explain-warning" className="mt-2 text-xs leading-[1.5] break-words text-danger">
          {warning}
        </p>
      ) : null}

      {p.message ? (
        <p role="alert" className="mt-2 text-xs break-words text-danger">
          {p.message}
        </p>
      ) : null}

      {failed ? (
        <div role="alert" className="mt-2 flex min-w-0 flex-col gap-1">
          <p className="font-mono text-xs break-words text-danger">{errorHeadline(failed)}</p>
          {needsKey(p.node.transform, failed) ? <KeyHint /> : null}
          <details className="min-w-0 rounded-control border border-hairline" onClick={(e) => e.stopPropagation()}>
            <summary className="flex h-row-compact items-center px-2 text-xs text-fg-muted select-none hover:bg-muted">Traceback</summary>
            <pre className="m-0 max-h-[240px] overflow-auto border-t border-hairline p-2 font-mono text-2xs whitespace-pre text-fg-muted">
              {failed}
            </pre>
          </details>
        </div>
      ) : null}

      {/* The options open and close by height (motion 2). Closed, they leave the tab order. */}
      <div
        id={`${id}-options`}
        data-testid="step-options"
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-(--dur-mid) ease-(--ease-in) motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
      <div className="min-h-0 overflow-hidden">
      <div className="flex min-w-0 flex-col gap-3 pt-3">
      {p.lesson?.length ? (
        <StageLesson title={LESSON_TITLE[p.node.stage] ?? `What does ${p.title} do?`} paragraphs={p.lesson} />
      ) : null}

      {isSource ? null : (
      <div className="flex min-w-0 flex-col gap-1">
        <TransformSelect
          id={`${id}-transform`}
          label="Transform"
          transforms={p.transforms}
          value={p.node.transform}
          upstream={p.upstream ?? {}}
          labelFor={transformLabel}
          onChange={p.onTransform}
        />
        {info?.learn?._strategy ? <LearnHint lesson={info.learn._strategy} /> : null}
      </div>
      )}

      {p.body ??
        (info ? (
          <SchemaForm
            key={`${p.node.id}:${info.name}`}
            schema={info.config_schema}
            value={p.node.config}
            onChange={p.onConfig}
            errors={p.fieldErrors}
            learn={info.learn}
          />
        ) : null)}

      {isSource ? null : (
      <div className="-mx-3 flex flex-col gap-2 border-t border-hairline px-3 pt-3">
      <footer className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={p.busy || Boolean(p.blockedBy)}
          onClick={(e) => {
            e.stopPropagation()
            p.onRun(false)
          }}
        >
          Run
        </Button>
        {hasOutput || failed ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={p.busy || Boolean(p.blockedBy)}
            title="Run again, ignoring the cache"
            onClick={(e) => {
              e.stopPropagation()
              p.onRun(true)
            }}
          >
            Rerun
          </Button>
        ) : null}
        {runNote ? (
          <span data-testid="run-note" className={cn("text-xs", p.blockedBy && !needsFile ? "text-danger" : "text-fg-muted")}>
            {runNote}
          </span>
        ) : null}
        {p.actions}
      </footer>
      {completed ? (
        <WhatItDid stage={p.node.stage} type={info?.output} artifactId={completed} previousId={p.previousArtifactId} stale={p.stale} />
      ) : null}
      </div>
      )}
      </div>
      </div>
      </div>
    </article>
    </Popover.Anchor>
    <ExplainPanel
      title={p.title}
      stage={p.node.stage}
      transform={p.node.transform}
      what={p.what}
      summary={info?.summary}
      explain={p.explain}
      anchor={() => cardRef.current}
    />
    </Popover.Root>
  )
}
