import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Info, X } from "lucide-react"
import { Popover } from "radix-ui"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { GraphNode, TransformInfo } from "@/api/types"
import type { ExplainState } from "@/api/useExplain"
import type { FieldErrors } from "@/components/fields/schema"
import { CONST_TEXT } from "@/components/fields/ConstField"
import { CONTROL } from "@/components/fields/types"
import { KeyHint } from "@/components/ApiKeyControl"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { errorHeadline } from "@/state/pipeline"

import { ExplainPanel } from "./ExplainPanel"
import { WhatItDid } from "./WhatItDid"

/**
 * One node of the pipeline column. The container encodes state (contract §5):
 * its left rule is solid when the output was computed by the last run that
 * touched it, dotted when it came from the cache, and absent when there is no
 * current output. No status dots.
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
  /** Tooltip for Run when it runs more than this card (Ask runs through Search). */
  runTitle?: string
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
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return ""
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 10) return `${Math.round(ms)} ms`
  return `${ms.toFixed(1)} ms`
}

type Shown = { label: string; rule: "solid" | "dotted" | "failed" | "none"; duration?: number }

export function describeResult(result: NodeState | undefined, stale: boolean | undefined): Shown {
  if (!result) return { label: "not run", rule: "none" }
  switch (result.status) {
    case "running":
      return { label: "running", rule: "none" }
    case "failed":
      return { label: "failed", rule: "failed" }
    case "skipped":
      return { label: "skipped", rule: "none" }
    case "done":
      return stale ? { label: "changed, not run", rule: "none" } : { label: "computed", rule: "solid", duration: result.duration_ms }
    case "cached":
      return stale ? { label: "changed, not run", rule: "none" } : { label: "cached", rule: "dotted", duration: result.duration_ms }
    default:
      return { label: "not run", rule: "none" }
  }
}

const RULE: Record<Shown["rule"], CSSProperties> = {
  solid: { borderLeft: "3px solid var(--text-secondary)" },
  dotted: { borderLeft: "3px dotted var(--text-secondary)" },
  failed: { borderLeft: "3px solid var(--danger)" },
  none: { borderLeft: "3px solid transparent" },
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
  const info = p.transforms.find((t) => t.name === p.node.transform)
  const shown = describeResult(p.result, p.stale)
  const failed = p.result?.status === "failed" && !p.stale ? p.result.error : undefined
  const hasOutput = shown.rule === "solid" || shown.rule === "dotted"
  const running = p.result?.status === "running" && !p.stale
  const elapsed = useElapsed(running ? p.result?.started_at : undefined)
  const cardRef = useRef<HTMLElement>(null)
  const warning = p.explain?.data?.warning
  const completed = (p.result?.status === "done" || p.result?.status === "cached") && p.result.artifact_id ? p.result.artifact_id : undefined
  const runNote = p.blockedBy
    ? p.blockedBy === p.title
      ? "Fix the settings to run."
      : `Fix the ${p.blockedBy} settings to run.`
    : completed && p.stale
      ? "Settings changed since the last run."
      : null

  return (
    <Popover.Root open={p.explainOpen} onOpenChange={p.onExplainOpenChange}>
    <Popover.Anchor asChild>
    <article
      ref={cardRef}
      aria-label={`${p.title} ${p.node.transform}`}
      data-node-id={p.node.id}
      data-rule={shown.rule}
      aria-current={p.selected ? "true" : undefined}
      onClick={p.onSelect}
      style={RULE[shown.rule]}
      className={cn(
        "flex min-w-0 flex-col gap-3 bg-surface p-3",
        p.selected && "bg-selection",
        p.explainOpen && "outline-1 -outline-offset-1 outline-fg-muted outline-solid",
      )}
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-sm font-semibold">{p.title}</h3>
          {p.showId ? <span className="truncate font-mono text-xs text-fg-muted">{p.node.id}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2" aria-live="polite">
          <span className="meta">{shown.label}</span>
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
              <Info aria-hidden strokeWidth={1.5} className="size-[16px]" />
            </Button>
          </Popover.Trigger>
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

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-transform`} className="text-sm font-medium">
          Transform
        </label>
        {p.transforms.length === 1 ? (
          // One registered transform: nothing to choose, so no picker.
          <output id={`${id}-transform`} className={CONST_TEXT}>
            {p.node.transform}
          </output>
        ) : (
          <select id={`${id}-transform`} className={CONTROL} value={p.node.transform} onChange={(e) => p.onTransform(e.target.value)}>
            {p.transforms.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {p.body ??
        (info ? (
          <SchemaForm key={`${p.node.id}:${info.name}`} schema={info.config_schema} value={p.node.config} onChange={p.onConfig} errors={p.fieldErrors} />
        ) : null)}

      {warning ? (
        <p role="status" data-testid="explain-warning" className="text-xs leading-[1.5] break-words text-danger">
          {warning}
        </p>
      ) : null}

      {p.message ? (
        <p role="alert" className="text-xs break-words text-danger">
          {p.message}
        </p>
      ) : null}

      {failed ? (
        <div role="alert" className="flex min-w-0 flex-col gap-1">
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

      <div className="-mx-3 flex flex-col gap-2 border-t border-hairline px-3 pt-3">
      <footer className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={p.busy || Boolean(p.blockedBy)}
          title={p.runTitle}
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
          <span data-testid="run-note" className={cn("text-xs", p.blockedBy ? "text-danger" : "text-fg-muted")}>
            {runNote}
          </span>
        ) : null}
        {p.actions}
      </footer>
      {completed ? (
        <WhatItDid stage={p.node.stage} type={info?.output} artifactId={completed} previousId={p.previousArtifactId} stale={p.stale} />
      ) : null}
      </div>
    </article>
    </Popover.Anchor>
    <ExplainPanel
      title={p.title}
      transform={p.node.transform}
      what={p.what}
      summary={info?.summary}
      explain={p.explain}
      anchor={() => cardRef.current}
    />
    </Popover.Root>
  )
}
