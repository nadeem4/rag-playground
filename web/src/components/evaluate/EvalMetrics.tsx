import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { cn } from "@/lib/utils"
import type { EvalMetrics, TagMetrics } from "@/state/evaluate"
import { numbersRow } from "@/state/evaluateView"

/**
 * Every number behind the headline, in one row under the finding: each by its
 * plain name with the technical name in brackets, and what it was in the last
 * run when that differs. Recall joins only when a question has more than one
 * passage; the per-tag hit rates and the reranker's effect follow in a line.
 * "What these mean" opens How it is scored, where each number is worked out.
 */
export function EvalNumbers({
  metrics: m,
  before,
  byTag,
  topK,
  rerank,
  onExplain,
}: {
  metrics: EvalMetrics
  before: EvalMetrics | null
  byTag: TagMetrics[]
  topK: number
  rerank: string | null
  onExplain: () => void
}) {
  const figures = numbersRow(m, before, topK)
  const tags = byTag.map((t) => `${t.tag} ${t.metrics.hits} of ${t.metrics.scored} found`)
  return (
    <div className="flex flex-col gap-2 border-y border-hairline py-3">
      <dl data-testid="numbers" className="m-0 flex flex-wrap gap-x-6 gap-y-2">
        {figures.map((f) => (
          <div key={f.label} className="flex min-w-[9rem] flex-col gap-1">
            <dt className="text-xs text-fg-muted">{f.label}</dt>
            <dd className="m-0 font-mono text-base font-medium text-fg tabular-nums">
              {f.value}
              {f.was ? <span className="ml-2 font-sans text-xs font-normal text-fg-muted">was {f.was}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-fg-muted">
        {tags.length ? <span data-testid="by-tag">By tag: {tags.join(", ")}. </span> : null}
        <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center")} onClick={onExplain}>
          What these mean
        </button>
      </p>
      {rerank ? (
        <p data-testid="rerank-effect" className="text-sm text-fg-muted">
          {rerank}
        </p>
      ) : null}
    </div>
  )
}
