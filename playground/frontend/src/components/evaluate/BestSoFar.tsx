import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { whenText, type BestRun, type Outcome } from "@/state/best"

/**
 * Best so far, under the score: how this run compares with the best run in
 * this browser for the same questions, documents and Pieces checked. Worse
 * names the lost questions and offers the best pipeline; better names the won
 * ones; the first run becomes the best. `outcome` null means the visitor
 * pressed Forget best.
 */

const mrr = (x: number | null) => (x === null ? "none" : x.toFixed(2))
const scoreOf = (b: BestRun) => `${b.found} of ${b.scored}, MRR ${mrr(b.mrr)}`

const TONE = {
  worse: "bg-warn text-warn-text",
  better: "bg-kept text-kept-text",
  first: "bg-surface-elevated text-fg",
  equal: "text-fg-muted",
  forgotten: "text-fg-muted",
}

function Changed({ kind, questions }: { kind: "lost" | "won"; questions: string[] }) {
  if (!questions.length) return null
  return (
    <ul aria-label={kind === "lost" ? "Lost since your best" : "Won since your best"} className="m-0 flex list-none flex-col gap-1 p-0">
      {questions.map((q) => (
        <li key={q} className="flex items-baseline gap-2">
          <span className={cn("rounded-swatch px-2 font-mono text-xs whitespace-nowrap", kind === "lost" ? "bg-removed text-removed-text" : "bg-surface text-fg")}>{kind}</span>
          <span>{q}</span>
        </li>
      ))}
    </ul>
  )
}

export function BestSoFar({
  outcome,
  now,
  onLoad,
  onCompare,
  onForget,
}: {
  outcome: Outcome | null
  /** This run's counts, for the equal line. */
  now: { found: number; scored: number }
  onLoad: () => void
  onCompare: () => void
  onForget: () => void
}) {
  const kind = outcome?.kind ?? "forgotten"
  return (
    <div className="flex max-w-[70ch] flex-col gap-2">
      <div data-testid="best-so-far" aria-live="polite" className={cn("flex flex-col gap-2 rounded-panel text-sm", kind === "equal" || kind === "forgotten" ? "" : "px-3 py-2", TONE[kind])}>
        {outcome === null ? (
          <p>Best forgotten. Your next run with these questions becomes the best.</p>
        ) : outcome.kind === "first" ? (
          <p>
            <strong className="font-semibold">Your first run with these questions</strong>, so it is your best so far. Change a step and run again to see if
            it gets better or worse.
          </p>
        ) : outcome.kind === "equal" ? (
          <p>
            <MonoNumbers text={`Same as your best: ${now.found} of ${now.scored}.`} />
          </p>
        ) : outcome.kind === "better" ? (
          <>
            <p>
              <strong className="font-semibold">New best.</strong>{" "}
              <MonoNumbers
                text={`${outcome.more > 0 ? `${outcome.more} more found than` : "The answers rank higher than in"} the last best (${scoreOf(outcome.before)}). This pipeline is now your best for these questions.`}
              />
            </p>
            <Changed kind="won" questions={outcome.won} />
          </>
        ) : (
          <>
            <p>
              <strong className="font-semibold">{outcome.fewer > 0 ? `${outcome.fewer} fewer found than your best.` : "Your best ranks the answers higher."}</strong>{" "}
              <MonoNumbers text={`Best so far: ${scoreOf(outcome.best)}, with `} />
              <strong className="font-semibold">{outcome.best.name}</strong>, {whenText(outcome.best.at)}.
            </p>
            <Changed kind="lost" questions={outcome.lost} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onLoad}>
                Load the best pipeline
              </Button>
              <Button variant="outline" size="sm" onClick={onCompare}>
                Compare the two
              </Button>
              <button type="button" className={cn(LINK_BUTTON, "ml-auto inline-flex items-center underline")} onClick={onForget}>
                Forget best
              </button>
            </div>
          </>
        )}
      </div>
      <p data-testid="best-note" className="text-xs text-fg-muted">
        Only questions decide "better" and "worse": found counts first, then MRR to break a tie. Best so far is kept per browser, so on the demo it
        lives only in this browser. Forget best clears it.
      </p>
    </div>
  )
}
