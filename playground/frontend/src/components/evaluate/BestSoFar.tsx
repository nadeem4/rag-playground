import { useId, useState, type ReactNode } from "react"

import { MonoNumbers } from "@/components/pipeline/WhatItDid"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { bestHeadline, betterLine, whenText, type BestRun, type Outcome } from "@/state/best"

/**
 * Best so far, under the score: how this run compares with the best run in
 * this browser for the same questions, documents and Pieces checked. Worse
 * names the lost questions and offers the best pipeline; better names the won
 * ones and any it lost; the first run becomes the best. On worse and better,
 * Compare the two opens `compare` in place under the box. It stays mounted
 * once opened, so closing and opening it again does not start it over. `outcome` null means the visitor
 * pressed Forget best. The page's own live region reads the headline out, so
 * this box is not a live region.
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

/** Pandion's notes on the comparison, such as a partial set or a step that can miss by chance. */
function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null
  return (
    <ul aria-label="About this comparison" data-testid="best-notes" className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

export function BestSoFar({
  documents = 1,
  outcome,
  problem,
  onLoad,
  compare,
  onForget,
}: {
  /** How many documents the run searched: with several, the first best names them. */
  documents?: number
  outcome: Outcome | null
  /** Why the best pipeline cannot open on this server, after a press of Load the best pipeline. */
  problem: string | null
  onLoad: () => void
  /** This run against the best, shown in place by Compare the two. */
  compare: ReactNode
  onForget: () => void
}) {
  const kind = outcome?.kind ?? "forgotten"
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)
  const compareButton = (
    <Button
      variant="outline"
      size="sm"
      aria-expanded={open}
      // The panel is in the page only once it has been opened.
      aria-controls={opened ? panelId : undefined}
      onClick={() => {
        setOpen(!open)
        setOpened(true)
      }}
    >
      Compare the two
    </Button>
  )
  return (
    <div className="flex max-w-[70ch] flex-col gap-2">
      <div data-testid="best-so-far" className={cn("flex flex-col gap-2 rounded-panel text-sm", kind === "equal" || kind === "forgotten" ? "" : "px-3 py-2", TONE[kind])}>
        {outcome === null ? (
          <p>Best forgotten. Your next run with these questions becomes the best.</p>
        ) : outcome.kind === "first" ? (
          documents > 1 ? (
            <p>
              <strong className="font-semibold">Your first run with these {documents} documents and questions</strong>, so it is your best so far. Adding or
              removing a document, or questions, starts a new best.
            </p>
          ) : (
            <p>
              <strong className="font-semibold">Your first run with these questions</strong>, so it is your best so far. Change a step and run again to see if
              it gets better or worse.
            </p>
          )
        ) : outcome.kind === "equal" ? (
          <>
            <p>
              <MonoNumbers text={bestHeadline(outcome)} />
            </p>
            <Notes notes={outcome.notes} />
          </>
        ) : outcome.kind === "better" ? (
          <>
            <p>
              <strong className="font-semibold">{bestHeadline(outcome)}</strong>{" "}
              <MonoNumbers text={`${betterLine(outcome)} (${scoreOf(outcome.before)}). This pipeline is now your best for these questions.`} />
            </p>
            <Changed kind="won" questions={outcome.won} />
            <Changed kind="lost" questions={outcome.lost} />
            <Notes notes={outcome.notes} />
            <div className="flex flex-wrap items-center gap-2">{compareButton}</div>
          </>
        ) : (
          <>
            <p>
              <strong className="font-semibold">
                <MonoNumbers text={bestHeadline(outcome)} />
              </strong>{" "}
              <MonoNumbers text={`Best so far: ${scoreOf(outcome.best)}, with `} />
              <strong className="font-semibold">{outcome.best.name}</strong>, {whenText(outcome.best.at)}.
            </p>
            <Changed kind="lost" questions={outcome.lost} />
            <Notes notes={outcome.notes} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onLoad}>
                Load the best pipeline
              </Button>
              {compareButton}
              <button type="button" className={cn(LINK_BUTTON, "ml-auto inline-flex items-center text-current underline")} onClick={onForget}>
                Forget best
              </button>
            </div>
            {problem ? (
              <p role="alert" data-testid="best-problem">
                {problem}
              </p>
            ) : null}
          </>
        )}
      </div>
      {opened && (outcome?.kind === "worse" || outcome?.kind === "better") ? (
        <div id={panelId} hidden={!open}>
          {compare}
        </div>
      ) : null}
      <p data-testid="best-note" className="text-xs text-fg-muted">
        Only questions decide "better" and "worse": found counts first, then MRR to break a tie. Best so far is kept per browser, so on the demo it
        lives only in this browser. Forget best clears it.
      </p>
    </div>
  )
}
