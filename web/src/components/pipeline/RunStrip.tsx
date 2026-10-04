import type { NodeState } from "@/api/runState"
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
  | { kind: "failed"; title: string }
  | null

/** Each bar's look. The running bar breathes like the card edge; under reduced motion it is a still fill. */
const BAR: Record<SegmentState, string> = {
  todo: "bg-hairline",
  running: "bg-primary step-running-edge",
  done: "bg-primary",
  reused: "border border-dashed border-primary bg-primary/40",
  failed: "bg-danger",
  stale: "bg-stale",
}

/** One segment per index step, with the state of its latest result. */
export function stripSegments(steps: GraphNode[], results: Record<string, NodeState>, stale: Set<string>): StripSegment[] {
  return steps.map((n) => {
    const r = results[n.id]
    let state: SegmentState = "todo"
    if (r?.status === "running") state = "running"
    else if (r?.status === "failed") state = stale.has(n.id) ? "stale" : "failed"
    else if (r?.status === "done" || r?.status === "cached") state = stale.has(n.id) ? "stale" : r.status === "cached" ? "reused" : "done"
    return { id: n.id, title: titleFor(n), state }
  })
}

/** "3.4 s" under ten seconds, whole seconds above. */
function seconds(ms: number): string {
  const s = ms / 1000
  return s < 10 ? s.toFixed(1) : String(Math.round(s))
}

function LineText({ line }: { line: Exclude<StripLine, null> }) {
  const startedAt = line.kind === "building" || line.kind === "running" ? line.startedAt : undefined
  const elapsed = useElapsed(startedAt)
  const secs = elapsed !== undefined ? <span className="font-mono">, {elapsed} s</span> : null
  switch (line.kind) {
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
    case "built":
      return (
        <>
          Built in <span className="font-mono">{seconds(line.totalMs)} s</span>
        </>
      )
    case "failed":
      return <>{line.title} failed</>
  }
}

export function RunStrip({ segments, line }: { segments: StripSegment[]; line: StripLine }) {
  return (
    <div data-testid="run-strip" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2">
      <ol aria-label="Index steps" className="m-0 grid min-w-[180px] flex-1 auto-cols-fr grid-flow-col gap-1 p-0">
        {segments.map((s) => (
          <li key={s.id} data-segment={s.id} data-state={s.state} className="flex min-w-0 list-none flex-col gap-1">
            <span aria-hidden data-testid="strip-bar" className={cn("block h-[4px] rounded-full", BAR[s.state])} />
            <span className={cn("truncate text-2xs", s.state === "failed" ? "text-danger" : "text-fg-muted")}>
              {s.title}
              {s.state === "failed" ? " failed" : null}
            </span>
          </li>
        ))}
      </ol>
      {line ? (
        <p data-testid="run-line" className={cn("m-0 text-xs whitespace-nowrap", line.kind === "failed" ? "text-danger" : "text-fg")}>
          <LineText line={line} />
        </p>
      ) : null}
    </div>
  )
}
