import { QUEUED_LINE, type NodeState } from "@/api/runState"
import type { GraphNode } from "@/api/types"
import { cn } from "@/lib/utils"
import { titleFor } from "@/state/graph"

import { useElapsed } from "./useElapsed"

/**
 * The run strip: one short bar per index step, in column order, at the top of
 * the index column, so which step is running stays in view while the reader
 * looks at the Ask panel. Beside it, one line says what is happening.
 */

export type SegmentState = "todo" | "running" | "done" | "reused" | "failed" | "stale"

export interface StripSegment {
  id: string
  title: string
  state: SegmentState
}

export type StripLine =
  | { kind: "building"; title?: string; startedAt?: number }
  | { kind: "running"; title: string; startedAt?: number }
  | { kind: "built"; totalMs: number }
  /** Every step came from the cache, so nothing ran again. */
  | { kind: "reused" }
  | { kind: "failed"; title: string }
  /** The server refused the run before it started; the reason is in the note above the cards. */
  | { kind: "refused" }
  /** The run waits its turn on the busy demo. */
  | { kind: "queued" }
  | null

/**
 * Each bar's look. The running bar breathes like the card edge; under reduced
 * motion it is a still half fill in a hairline outline, so it never reads as done.
 */
const BAR: Record<SegmentState, string> = {
  todo: "bg-hairline",
  running: "relative overflow-hidden bg-primary step-running-edge motion-reduce:border motion-reduce:border-hairline motion-reduce:bg-transparent",
  done: "bg-primary",
  reused: "border border-dashed border-primary bg-primary/40",
  failed: "bg-danger",
  stale: "bg-stale",
}

const STATE_WORD: Record<SegmentState, string> = {
  todo: "to go",
  running: "running",
  done: "done",
  reused: "reused",
  failed: "failed",
  stale: "changed",
}

/** The run in flight: the steps it covers, and its own node states (not the last run's). */
export interface LiveRun {
  ids: Set<string>
  nodes: Record<string, NodeState>
}

function stateOf(r: NodeState | undefined, stale: boolean, live: boolean): SegmentState {
  if (r?.status === "running") return live ? "running" : "todo"
  if (r?.status === "failed") return stale ? "stale" : "failed"
  if (r?.status === "done" || r?.status === "cached") return stale ? "stale" : r.status === "cached" ? "reused" : "done"
  return "todo"
}

/**
 * One segment per index step. While a run is in flight, a step it covers shows
 * that run's own state, so a step not reached yet is to go; other steps keep
 * their last look. Stacked cleaners are numbered by position (Clean 1, Clean 2).
 */
export function stripSegments(steps: GraphNode[], results: Record<string, NodeState>, stale: Set<string>, live?: LiveRun): StripSegment[] {
  const count = new Map<string, number>()
  for (const n of steps) count.set(titleFor(n), (count.get(titleFor(n)) ?? 0) + 1)
  const seen = new Map<string, number>()
  return steps.map((n) => {
    const base = titleFor(n)
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    const title = (count.get(base) ?? 0) > 1 ? `${base} ${nth}` : base
    const state = live?.ids.has(n.id) ? stateOf(live.nodes[n.id], false, true) : stateOf(results[n.id], stale.has(n.id), false)
    return { id: n.id, title, state }
  })
}

/** "under 0.1 s", "3.4 s" under ten seconds, whole seconds above. */
function seconds(ms: number): string {
  const s = ms / 1000
  if (s < 0.1) return "under 0.1 s"
  return `${s < 10 ? s.toFixed(1) : String(Math.round(s))} s`
}

function LineText({ line }: { line: Exclude<StripLine, null> }) {
  const startedAt = line.kind === "building" || line.kind === "running" ? line.startedAt : undefined
  const elapsed = useElapsed(startedAt)
  const secs = elapsed !== undefined ? <span className="font-mono">, {elapsed} s</span> : null
  switch (line.kind) {
    case "queued":
      return <>{QUEUED_LINE}</>
    case "building":
      return line.title ? (
        <>
          Building: {line.title}
          {secs}
        </>
      ) : (
        <>Building</>
      )
    case "running":
      return (
        <>
          Running {line.title}
          {secs}
        </>
      )
    case "reused":
      return <>From the cache, nothing ran again</>
    case "built":
      return (
        <>
          Built in <span className="font-mono">{seconds(line.totalMs)}</span>
        </>
      )
    case "failed":
      return <>{line.title} failed</>
    case "refused":
      return <>Could not start. See the note above the cards.</>
  }
}

/** `bare` drops the column's border and padding, for the strip inside another panel (Evaluate's run panel). */
export function RunStrip({ segments, line, bare = false }: { segments: StripSegment[]; line: StripLine; bare?: boolean }) {
  return (
    <div
      data-testid="run-strip"
      className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1", bare ? "" : "border-b border-hairline px-3 py-2")}
    >
      {/* Each segment keeps room for its label; when the line does not fit beside the
          bars it takes its own row, so labels never truncate and bars never jump. */}
      <ol
        aria-label="Index steps"
        style={{ minWidth: `${segments.length * 4}rem` }}
        className="m-0 grid flex-1 auto-cols-fr grid-flow-col gap-1 p-0"
      >
        {segments.map((s) => (
          <li
            key={s.id}
            data-segment={s.id}
            data-state={s.state}
            aria-label={`${s.title}, ${STATE_WORD[s.state]}`}
            className="flex min-w-0 list-none flex-col gap-1"
          >
            <span aria-hidden data-testid="strip-bar" className={cn("block h-[4px] rounded-full", BAR[s.state])}>
              {s.state === "running" ? (
                <span data-testid="strip-half" className="absolute inset-y-0 left-0 hidden w-1/2 bg-primary motion-reduce:block" />
              ) : null}
            </span>
            <span aria-hidden className={cn("text-2xs", s.state === "failed" ? "text-danger" : "text-fg-muted")}>
              {s.title}
              {s.state === "failed" ? " failed" : null}
            </span>
          </li>
        ))}
      </ol>
      {line ? (
        <p data-testid="run-line" className={cn("m-0 text-xs whitespace-nowrap", line.kind === "failed" || line.kind === "refused" ? "text-danger" : "text-fg")}>
          <LineText line={line} />
        </p>
      ) : null}
    </div>
  )
}
