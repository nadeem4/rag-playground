import type { ReactNode } from "react"

import { percent, type EvalMetrics, type TagMetrics } from "@/state/evaluate"

/**
 * The numbers behind the headline (plan I-33). Hit rate at k sits in the strip
 * above, where it cannot be missed; everything else is one click away, because
 * a wall of rates is not a result.
 *
 * Recall appears only when a question has more than one gold passage, and the
 * per-tag table only when the set has tags, so neither reads as an empty row.
 */

export function EvalMetricsDetail({ metrics: m, byTag, topK, rerank }: { metrics: EvalMetrics; byTag: TagMetrics[]; topK: number; rerank: string | null }) {
  return (
    <details data-testid="more-metrics" className="shrink-0 border-b border-hairline">
      <summary className="cursor-pointer list-none px-3 py-1 text-xs text-fg-muted hover:bg-muted">All the numbers</summary>
      <div className="flex flex-col gap-3 border-t border-hairline px-3 py-2">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-2">
          <Figure label="Mean reciprocal rank" value={m.mrr === null ? null : m.mrr.toFixed(2)}>
            Finding the answer first counts more than finding it fifth.
          </Figure>
          {m.recall === null ? null : (
            <Figure label={`Recall at ${topK}`} value={percent(m.recall)}>
              {m.goldsFound} of {m.goldsTotal} gold passages were in the top {topK}.
            </Figure>
          )}
          <Figure
            label="Average rank of the first hit"
            value={m.meanRank === null ? null : m.meanRank.toFixed(1)}
            testId="average-rank"
          >
            Over the {m.hits} questions that found the answer.
          </Figure>
          <Figure label="Middle rank of the first hit" value={m.medianRank === null ? null : String(m.medianRank)}>
            Half the questions that hit found it above this.
          </Figure>
        </dl>

        {m.spread.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="meta">questions by the rank they found it at</p>
            <dl data-testid="rank-spread" className="flex flex-wrap gap-x-4 gap-y-1">
              {m.spread.map((s) => (
                <div key={s.rank} className="flex items-baseline gap-1">
                  <dt className="meta">rank {s.rank}</dt>
                  <dd className="font-mono text-sm text-fg tabular-nums">{s.count}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {byTag.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="meta">by tag</p>
            <div data-testid="by-tag" className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-px bg-hairline">
              <span className="meta bg-surface px-2 py-1">tag</span>
              <span className="meta bg-surface px-2 py-1 text-right">found</span>
              <span className="meta bg-surface px-2 py-1 text-right">rate</span>
              {byTag.map((t) => (
                <TagRow key={t.tag} tag={t} />
              ))}
            </div>
          </div>
        ) : null}

        {rerank ? (
          <p data-testid="rerank-effect" className="text-sm text-fg-muted">
            {rerank}
          </p>
        ) : null}
      </div>
    </details>
  )
}

function TagRow({ tag }: { tag: TagMetrics }) {
  const m = tag.metrics
  return (
    <>
      <span className="bg-surface px-2 py-1 text-sm break-words text-fg">{tag.tag}</span>
      <span className="bg-surface px-2 py-1 text-right font-mono text-sm text-fg tabular-nums">
        {m.hits}/{m.scored}
      </span>
      <span className="bg-surface px-2 py-1 text-right font-mono text-sm text-fg tabular-nums">{percent(m.hitRate) ?? ""}</span>
    </>
  )
}

function Figure({
  label,
  value,
  testId,
  children,
}: {
  label: string
  value: string | null
  testId?: string
  children: ReactNode
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1">
      <dt className="meta">{label}</dt>
      <dd className="font-mono text-sm font-medium text-fg tabular-nums">{value ?? "not yet"}</dd>
      <p className="text-xs text-fg-muted">{children}</p>
    </div>
  )
}
