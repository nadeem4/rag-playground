import { Fragment } from "react"

import { fmtScore, type HitRowData } from "@/components/inspectors/hits"
import { GUIDE_LINE, fill } from "@/state/guide"
import type { Found } from "@/state/guideResult"

/**
 * The guided run's Ask step in the main pane: the question, every candidate
 * Search returned in rank order, the row that holds the answer marked, and a
 * dashed line after the pieces the answer step reads.
 */
export function GuideAskResults({ question, candidates, shown, found }: { question: string; candidates: HitRowData[]; shown: number; found: Found }) {
  return (
    <section aria-label="Ask results" className="flex flex-col gap-3">
      <p data-testid="guide-question" className="m-0 font-serif text-base text-fg">
        {question}
      </p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {candidates.map((c, i) => (
          <Fragment key={c.chunk_id}>
            <li
              data-guide-row=""
              data-answer={found?.rank === c.rank ? "" : undefined}
              className="flex gap-3 rounded-control border border-hairline bg-surface p-3 data-answer:border-accent data-answer:outline-2 data-answer:outline-accent"
            >
              <span className="font-mono text-sm text-fg-muted">{c.rank}</span>
              <p className="m-0 line-clamp-3 min-w-0 flex-1 text-sm text-fg">{c.text}</p>
              <span className="font-mono text-xs text-fg-muted">{fmtScore(c.score)}</span>
            </li>
            {i + 1 === shown && shown < candidates.length ? (
              <li data-testid="guide-line" className="list-none border-t border-dashed border-fg-muted pt-1 text-xs text-fg-muted">
                {fill(GUIDE_LINE, { shown })}
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
    </section>
  )
}
