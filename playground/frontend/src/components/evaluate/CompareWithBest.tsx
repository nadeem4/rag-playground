import { useEffect, useRef, useState } from "react"

import type { EvaluationResult, Registry } from "@/api/types"
import { useRun } from "@/api/useRun"
import { v2 } from "@/api/v2"
import { Button } from "@/components/ui/button"
import { pipelineDiff, questionGroups, type QuestionPair } from "@/state/bestCompare"
import type { PipelineConfig } from "@/state/config"
import { errorHeadline } from "@/state/pipeline"

/**
 * Compare the two, open under Best so far: the steps that differ between this
 * run's pipeline and the other one (the best, or on a better run the best it
 * replaced), then each question in one of four groups with each run's rank.
 * Best so far keeps only found or missed per question, so the other pipeline
 * runs once on the same questions when this opens (`start`); its steps shared
 * with this run come from the cache. That run is not judged for Best so far.
 */

function Group({ title, pairs, open, otherName }: { title: string; pairs: QuestionPair[]; open: boolean; otherName: string }) {
  return (
    <details open={open} aria-label={`${title} ${pairs.length}`} className="border-t border-hairline py-1">
      <summary className="cursor-pointer py-1 font-medium">
        {title} <span className="font-mono text-fg-muted tabular-nums">{pairs.length}</span>
      </summary>
      {pairs.length ? (
        <table className="w-full text-left text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-normal">Question</th>
              <th className="py-1 pr-3 font-normal whitespace-nowrap">This run</th>
              <th className="py-1 font-normal whitespace-nowrap">{otherName}</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="py-1 pr-3">{p.question}</td>
                <td className="py-1 pr-3 font-mono whitespace-nowrap">{p.now}</td>
                <td className="py-1 font-mono whitespace-nowrap">{p.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-1 text-xs text-fg-muted">None.</p>
      )}
    </details>
  )
}

export function CompareWithBest({
  now,
  nowConfig,
  otherConfig,
  otherName,
  label,
  registry,
  start,
}: {
  /** This run's report. */
  now: EvaluationResult
  nowConfig: PipelineConfig
  otherConfig: PipelineConfig
  /** The other pipeline's name in the picker. */
  otherName: string
  /** What the other run is called in a sentence: "your best", or "the last best" on a better run. */
  label: string
  registry: Registry
  /** Run the other pipeline on this run's questions; resolves to its run id. */
  start: () => Promise<string>
}) {
  const [runId, setRunId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const run = useRun(runId)
  const result = (run.result as EvaluationResult | null) ?? null

  function go() {
    setRunId(null)
    setStartError(null)
    start().then(setRunId, (err: unknown) => setStartError(err instanceof Error ? err.message : String(err)))
  }
  // Runs once, when the panel first opens.
  const began = useRef(false)
  useEffect(() => {
    if (began.current) return
    began.current = true
    go()
  })
  // Leaving the page or starting a new evaluation stops a run still going, so it does not hold up the next one.
  const going = useRef<string | null>(null)
  going.current = runId && !run.closed ? runId : null
  useEffect(() => () => void (going.current && v2.cancelRun(going.current).catch(() => undefined)), [])

  const failed =
    startError ?? (run.error ? errorHeadline(run.error) : run.resultFailed ? "its scores could not be read" : run.closed && (run.ok === false || result?.cancelled) ? "it stopped" : null)
  const { rows, same } = pipelineDiff(nowConfig, otherConfig, registry)
  const groups = result && !result.cancelled ? questionGroups(now.questions, result.questions) : null
  const Label = label.charAt(0).toUpperCase() + label.slice(1)

  return (
    <section data-testid="compare-best" aria-label={`This run against ${label}`} className="flex max-w-[70ch] flex-col gap-3 rounded-panel bg-surface-elevated px-3 py-2 text-sm">
      <h3 className="font-semibold">This run against {label}</h3>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">What differs</h4>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-muted">
                <tr>
                  <th className="py-1 pr-3 font-normal">Step</th>
                  <th className="py-1 pr-3 font-normal">This run</th>
                  <th className="py-1 font-normal">{otherName}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.step} className="align-top">
                    <td className="py-1 pr-3">{r.step}</td>
                    <td className="py-1 pr-3 font-mono">{r.now}</td>
                    <td className="py-1 font-mono">{r.other}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">No step differs. The two runs can still differ when a step gives a different result each run.</p>
        )}
        {rows.length && same.length ? <p className="text-xs text-fg-muted">Same in both: {same.join(", ")}.</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">Question by question</h4>
        {failed ? (
          <p role="alert" className="text-xs text-danger">
            {Label} pipeline did not run: {failed}.{" "}
            <Button variant="outline" size="sm" onClick={go}>
              Try again
            </Button>
          </p>
        ) : groups ? (
          <>
            <Group title={`Only ${label} finds`} pairs={groups.onlyOther} open otherName={otherName} />
            <Group title="Only this run finds" pairs={groups.onlyNow} open otherName={otherName} />
            <Group title="Both find" pairs={groups.both} open={false} otherName={otherName} />
            <Group title="Both miss" pairs={groups.neither} open={false} otherName={otherName} />
            <p className="text-xs text-fg-muted">Rank is where the answer's piece came in the pieces checked. "Lost at" is the step where it dropped out.</p>
          </>
        ) : (
          <p role="status" className="text-xs text-fg-muted">
            Running {label} pipeline on these questions to get its ranks. Steps it shares with this run come from the cache.
          </p>
        )}
      </div>
    </section>
  )
}
