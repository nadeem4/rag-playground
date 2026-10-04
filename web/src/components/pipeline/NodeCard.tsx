import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react"
import { Info, X } from "lucide-react"
import { Popover } from "radix-ui"

import { needsKey } from "@/api/apiKey"
import type { NodeState } from "@/api/runState"
import type { GraphNode, TransformInfo } from "@/api/types"
import type { ExplainState } from "@/api/useExplain"
import { FieldHelp } from "@/components/fields/FieldHelp"
import type { FieldErrors } from "@/components/fields/schema"
import { KeyHint } from "@/components/ApiKeyControl"
import { fmt } from "@/components/inspectors/status"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { strategyLabel } from "@/learn/challenges"
import { cn } from "@/lib/utils"
import { STAGE_VERB } from "@/state/graph"
import { CHUNK_CLASSES } from "@/styles/dataClasses"
import { errorHeadline } from "@/state/pipeline"

import { ExplainPanel } from "./ExplainPanel"
import { lockOf, TransformSelect } from "./TransformSelect"
import { outcomeText, type Outcome } from "./outcome"
import { useElapsed } from "./useElapsed"
import { useOutcome } from "./useOutcome"
import { MonoNumbers, WhatItDid } from "./WhatItDid"

/**
 * One node of the pipeline column (foundation spec section 7), a tile on the
 * panel. A 14 px status ring before the step name shows the card's look
 * without reading a word: grey when not run, half accent while running (with
 * a breathing top edge, and the title line reads "Parse, running, 3 s"), an
 * accent dot when done (dashed when reused from an earlier run), amber when
 * the settings changed since the run, danger when it failed. Under the name: the transform's plain name and code name, then the
 * result on one line. The options open below when the card is selected, the
 * selected card is the one raised card, and its head closes it again.
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
  /** The Document card's file is gone from this browser (an expired upload): say so on the closed card. */
  missing?: boolean
  onSelect: () => void
  /** Clicking the head of the selected card closes it. */
  onDeselect?: () => void
  onTransform: (name: string) => void
  onConfig: (config: Record<string, unknown>) => void
  onRun: (force: boolean) => void
  onRemove?: () => void
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
  /** Plan I-22: this stage's lesson paragraphs, when the server has them. Shown last in the explain pop-over. */
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
  idle: "border-field-border",
  running: "border-primary/50 bg-primary/50",
  done: "border-primary",
  stale: "border-stale",
  failed: "border-danger",
}

/** The outcome on one line, its headline number in bold and the other numbers in mono. */
function ResultLine({ outcome, testId = "step-summary", ref }: { outcome: Outcome; testId?: string; ref?: Ref<HTMLParagraphElement> }) {
  const text = outcomeText(outcome)
  const head = fmt(outcome.headline)
  const at = outcome.lead.lastIndexOf(head)
  return (
    <p ref={ref} data-testid={testId} title={text} className="m-0 mt-1 truncate text-sm text-fg">
      {at < 0 ? (
        <MonoNumbers text={text} />
      ) : (
        <>
          <MonoNumbers text={outcome.lead.slice(0, at)} />
          <span className="font-semibold">{head}</span>
          <MonoNumbers text={outcome.lead.slice(at + head.length) + outcome.tail} />
        </>
      )}
    </p>
  )
}

/**
 * The pieces to scale by tokens, in their chunk colours. Thin, 4 px, under the
 * Chunk card's result; a bar, 12 px with 2 px gaps and 3 px corners, in a
 * Compare column.
 */
export function ChunkBar({ data, size = "thin" }: { data: unknown; size?: "thin" | "bar" }) {
  const chunks = (data as { chunks?: { token_count?: number }[] } | null)?.chunks
  if (!Array.isArray(chunks) || chunks.length === 0) return null
  return (
    <div data-testid="chunk-bar" aria-hidden className={size === "bar" ? "flex h-[12px] gap-[2px]" : "mt-1 flex h-[4px] overflow-hidden rounded-full"}>
      {chunks.map((c, i) => (
        <span
          key={i}
          className={cn(CHUNK_CLASSES[i % CHUNK_CLASSES.length], size === "bar" && "min-w-[3px] rounded-[3px]")}
          style={{ flexGrow: c.token_count ?? 1, flexBasis: 0 }}
        />
      ))}
    </div>
  )
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

/** The nearest ancestor that scrolls (the column's box on desktop, `<main>` below md), or null for the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n
  }
  return null
}

/** How far the card's scroll box (or the window) is scrolled. */
function scrollTopOf(el: HTMLElement | null): number {
  const root = el ? scrollParent(el) : null
  return root ? root.scrollTop : window.scrollY
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Scrolls `el` into view (nearest) when it is outside its scroll box, or the window when nothing scrolls. */
function revealIfHidden(el: HTMLElement | null) {
  if (!el || typeof el.scrollIntoView !== "function") return
  const root = scrollParent(el)
  const view = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  const r = el.getBoundingClientRect()
  if (r.top < view.top || r.bottom > view.bottom) el.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" })
}

export function NodeCard(p: NodeCardProps) {
  const id = useId()
  // The Document card is deliberately plain: no run status, no explain button,
  // no transform picker, no fields and no footer. It only says which document
  // is in use; the header's Document control changes it.
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
  const headRef = useRef<HTMLElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const resultRef = useRef<HTMLParagraphElement>(null)
  const [stuck, setStuck] = useState(false)
  // Set when this card's run finishes, so its result line is brought into view once.
  const [reveal, setReveal] = useState(false)
  const wasRunning = useRef(running)
  // Where the column was scrolled when this card's run started.
  const startTop = useRef<number | undefined>(undefined)
  const warning = p.explain?.data?.warning
  const completed = (p.result?.status === "done" || p.result?.status === "cached") && p.result.artifact_id ? p.result.artifact_id : undefined
  const reused = shown.look === "done" && p.result?.status === "cached"
  // The summary row: the result's outcome on one line, without "(was N)",
  // computed or reused alike. Only the ring and the chip say it was reused.
  const outcome = useOutcome(p.node.stage, info?.output, shown.look === "done" ? completed : undefined)
  const ready = outcome?.kind === "ready" ? outcome : null
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

  // The head's name and the chevron both open a closed card and close the open one.
  const toggle = (e: MouseEvent) => {
    e.stopPropagation()
    if (p.selected && p.onDeselect) p.onDeselect()
    else p.onSelect()
  }

  // Selecting a card brings it into view after the card above has had its
  // --dur-mid to close. The card's own top is measured, not the head's: a stuck
  // head always reads as on screen. Its top goes to the box's top plus 12 px
  // (scroll-mt-3); a head below the box is brought up to the bottom edge.
  useEffect(() => {
    if (!p.selected) return
    const reduce = prefersReducedMotion()
    const t = window.setTimeout(
      () => {
        const card = cardRef.current
        const head = headRef.current
        if (!card || !head || typeof card.scrollIntoView !== "function") return
        const root = scrollParent(card)
        const view = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
        const behavior = reduce ? "auto" : "smooth"
        if (card.getBoundingClientRect().top < view.top) card.scrollIntoView({ block: "start", behavior })
        else if (head.getBoundingClientRect().bottom > view.bottom) head.scrollIntoView({ block: "nearest", behavior })
      },
      reduce ? 0 : 220,
    )
    return () => window.clearTimeout(t)
  }, [p.selected])

  // The head's height, as --head-h on the card: the options' fields keep that
  // much scroll margin, so focus never lands under the stuck head, wrapped or not.
  useEffect(() => {
    const card = cardRef.current
    const head = headRef.current
    if (!p.selected || !card || !head || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => card.style.setProperty("--head-h", `${head.getBoundingClientRect().height}px`))
    ro.observe(head)
    return () => {
      ro.disconnect()
      card.style.removeProperty("--head-h")
    }
  }, [p.selected])

  // A run of this card that ends with a result asks for the result line once,
  // unless the reader scrolled the column while it ran: then they are elsewhere.
  useEffect(() => {
    if (running) {
      setReveal(false)
      if (startTop.current === undefined) startTop.current = scrollTopOf(cardRef.current)
    } else {
      const moved = startTop.current !== undefined && Math.abs(scrollTopOf(cardRef.current) - startTop.current) > 2
      if (wasRunning.current && !failed && !moved) setReveal(true)
      startTop.current = undefined
    }
    wasRunning.current = running
  }, [running, failed])

  useEffect(() => {
    if (!reveal || !ready?.outcome) return
    setReveal(false)
    if (open) revealIfHidden(resultRef.current)
  }, [reveal, ready, open])

  // The open card's head sticks to the top of the scroll box; a zero-height
  // marker just above it says when it is stuck, for the hairline under it.
  useEffect(() => {
    setStuck(false)
    const mark = sentinelRef.current
    if (!p.selected || !mark || typeof IntersectionObserver === "undefined") return
    // The marker sits 12 px (the card's padding) below the head's top, so the
    // watched edge moves down 12 px to match the moment the head sticks.
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0)),
      { root: scrollParent(mark), rootMargin: "-12px 0px 0px 0px", threshold: 0 },
    )
    io.observe(mark)
    return () => io.disconnect()
  }, [p.selected])

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
        "relative flex min-w-0 scroll-mt-3 flex-col rounded-panel border border-hairline p-3",
        // A closed card tints on hover to say it opens; only the selected card is raised.
        p.selected
          ? "z-10 bg-surface-raised shadow-raised"
          : "bg-surface transition-colors duration-(--dur-fast) hover:border-field-border hover:bg-surface-raised",
        p.explainOpen && "outline-1 -outline-offset-1 outline-fg-muted outline-solid",
      )}
    >
      <div ref={sentinelRef} aria-hidden className="h-0" />
      {/* Wraps rather than squeezing: on a stacked step with a long chip, the
          chip and the buttons drop to their own line and the title and id stay whole.
          The open card's head sticks, with its breathing edge, so a run's status
          stays in view while the options scroll under it. */}
      <header
        ref={headRef}
        className={cn(
          "relative -mx-3 -mt-3 flex min-w-0 scroll-mt-3 flex-wrap items-start gap-x-2 gap-y-1 rounded-t-panel px-3 pt-3",
          p.selected && "sticky top-0 z-20 bg-surface-raised pb-2",
          p.selected && stuck && "rounded-none shadow-[0_1px_0_var(--hairline)]",
        )}
      >
        {shown.look === "running" && !isSource ? (
          <span aria-hidden data-testid="running-bar" className="step-running-edge pointer-events-none absolute inset-x-0 top-0 h-[2px] rounded-t-panel bg-primary" />
        ) : null}
        <div className="flex items-center gap-x-2">
          <h3 className="text-sm font-semibold">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-options`}
              onClick={toggle}
              className="flex min-h-row-compact items-center gap-2 rounded-control text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
            >
              {isSource ? null : (
                <span
                  aria-hidden
                  data-testid="status-ring"
                  className={cn(
                    "flex size-[14px] shrink-0 items-center justify-center rounded-full border-2",
                    RING[shown.look],
                    reused && "border-dashed",
                  )}
                >
                  {shown.look === "done" ? <span data-testid="ring-dot" className="size-[6px] rounded-full bg-primary" /> : null}
                </span>
              )}
              {/* One inline label, so the button's flex gap never opens before the comma.
                  While it runs, the title line says so, with the seconds (kept out of the
                  button's name, which would otherwise change every second). */}
              <span data-testid="card-title">
                {p.title}
                {running && !isSource ? (
                  <span className="font-normal text-fg-muted">
                    , running{elapsed !== undefined ? <span aria-hidden className="font-mono">, {elapsed} s</span> : null}
                  </span>
                ) : null}
              </span>
            </button>
          </h3>
          {p.showId ? <span className="font-mono text-xs whitespace-nowrap text-fg-muted">{p.node.id}</span> : null}
          {/* The explicit open and close, on the title line so it never wraps away.
              It follows selection, as clicking does. The Document card has nothing to open. */}
          {isSource ? null : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${p.selected ? "Collapse" : "Expand"} ${p.title}`}
              aria-expanded={p.selected}
              aria-controls={`${id}-options`}
              onClick={toggle}
            >
              <svg
                aria-hidden
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  "size-[16px] transition-transform duration-(--dur-fast) motion-reduce:transition-none",
                  p.selected && "rotate-180 motion-reduce:rotate-0",
                )}
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </Button>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2" aria-live="polite">
          {isSource ? null : (
            <>
              {(shown.look === "done" && !reused) || running ? null : (
                <span
                  data-testid="status-chip"
                  className={cn(
                    "rounded-full px-2 text-2xs whitespace-nowrap",
                    shown.look === "stale" ? "bg-stale-wash text-stale" : shown.look === "failed" ? "text-danger" : "text-fg-muted",
                  )}
                >
                  {shown.label}
                </span>
              )}
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
        p.missing ? (
          <>
            <p className="m-0 text-xs break-words text-fg-muted">{filename}</p>
            <p role="status" data-testid="missing-file" className="m-0 mt-1 self-start rounded-swatch bg-stale-wash px-2 py-px text-xs break-words text-stale">
              Missing. Pick a document in the bar above.
            </p>
          </>
        ) : (
          <p className="m-0 text-xs break-words text-fg-muted">{filename ? `${filename}. Change it in the bar above.` : "None yet. Pick one in the bar above."}</p>
        )
      ) : (
        <p data-testid="step-transform" className="m-0 text-xs break-words text-fg-muted">
          {plain === p.node.transform ? null : `${plain}, `}
          <span className="font-mono text-2xs">{p.node.transform}</span>
        </p>
      )}

      {/* Closed, the result shows here; open, it shows under the Run button instead. */}
      {ready?.outcome && !isSource && !open ? <ResultLine outcome={ready.outcome} /> : null}
      {ready && p.node.stage === "chunk" ? <ChunkBar data={ready.data} /> : null}

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
      {/* A field scrolled to by focus stops below the sticky head, not under it. */}
      <div className={cn("flex min-w-0 flex-col gap-3 pt-3", p.selected && "[&_*]:scroll-mt-(--head-h)")}>
      {isSource ? null : (
      <div className="flex min-w-0 flex-col gap-1">
        <TransformSelect
          id={`${id}-transform`}
          label="Transform"
          transforms={p.transforms}
          value={p.node.transform}
          upstream={p.upstream ?? {}}
          labelFor={transformLabel}
          info={<FieldHelp title="Transform" lesson={info?.learn?._strategy} />}
          onChange={p.onTransform}
        />
      </div>
      )}

      {isSource ? null : info ? (
          <SchemaForm
            key={`${p.node.id}:${info.name}`}
            schema={info.config_schema}
            value={p.node.config}
            onChange={p.onConfig}
            errors={p.fieldErrors}
            learn={info.learn}
          />
        ) : null}

      {isSource ? null : (
      <div className="-mx-3 flex flex-col gap-2 border-t border-hairline px-3 pt-3">
      <footer className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          busy={running}
          disabled={p.busy || Boolean(p.blockedBy)}
          onClick={(e) => {
            e.stopPropagation()
            p.onRun(false)
          }}
        >
          {running ? "Running" : "Run"}
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
        {running ? (
          <span data-testid="run-progress" className="text-xs text-fg-muted">
            Running {p.title}
            {elapsed !== undefined ? <span className="font-mono">, {elapsed} s</span> : null}
          </span>
        ) : null}
        {runNote ? (
          <span data-testid="run-note" className={cn("text-xs", p.blockedBy && !needsFile ? "text-danger" : "text-fg-muted")}>
            {runNote}
          </span>
        ) : null}
        {p.actions}
      </footer>
      {/* The outcome again, right under the buttons, so it shows where Run was pressed. */}
      {ready?.outcome ? <ResultLine ref={resultRef} outcome={ready.outcome} testId="run-result" /> : null}
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
      lesson={p.lesson}
      lessonTitle={LESSON_TITLE[p.node.stage]}
      anchor={() => cardRef.current}
    />
    </Popover.Root>
  )
}
