import type { Trace, TraceStep } from "@/api/types"
import { cn } from "@/lib/utils"

/**
 * Why did this miss? One question's answer followed down the pipeline: the
 * finding first, then each step with a mark, stopping where the answer was
 * lost. A broken parse shows the parsed text with the answer's words marked
 * and the words that broke into the sentence struck through, then the
 * sentence it looked for. A lost step ends with a fix and a link to that
 * step on Build.
 */

const STEP_WORD: Record<TraceStep["status"], string> = {
  pass: "Passed",
  lost: "Lost here",
  not_checked: "Not checked",
}

const DOT: Record<TraceStep["status"], string> = {
  pass: "bg-kept text-kept-text",
  lost: "bg-removed-mark text-primary-foreground",
  not_checked: "border-2 border-dashed border-hairline bg-surface text-fg-muted",
}

const MARK: Record<TraceStep["status"], string> = { pass: "✓", lost: "✕", not_checked: "" }

export function MissTrace({ trace, fixHref }: { trace: Trace; fixHref: string | null }) {
  const lost = trace.steps.find((s) => s.status === "lost")
  const [where, ...rest] = trace.finding.split(". ")
  return (
    <section data-trace="" aria-label="Where the answer was lost" className="flex flex-col gap-4 rounded-panel bg-surface-elevated p-4">
      <p className="text-lg leading-[1.3] font-semibold text-balance text-fg">
        <span className={lost ? "text-removed-mark" : "text-kept-mark"}>{where}.</span> {rest.join(". ")}
      </p>
      <ol className="flex flex-col">
        {trace.steps.map((s, i) => (
          <li key={`${s.stage}-${i}`} data-status={s.status} className="relative grid grid-cols-[26px_minmax(0,1fr)] gap-x-3 pb-3 md:grid-cols-[26px_92px_minmax(0,1fr)]">
            {i < trace.steps.length - 1 ? <span aria-hidden className="absolute top-[26px] bottom-0 left-3 w-0.5 bg-hairline" /> : null}
            <span aria-hidden className={cn("relative z-[1] grid size-[26px] place-items-center rounded-full text-[0.8125rem] font-bold", DOT[s.status])}>
              {MARK[s.status]}
            </span>
            <span className={cn("pt-[3px] font-semibold", s.status === "not_checked" ? "text-fg-muted" : "text-fg")}>
              {s.name}
              <span className="sr-only">: {STEP_WORD[s.status]}</span>
              {s.status === "lost" ? <span className="block text-xs font-normal text-removed-mark">{STEP_WORD.lost}</span> : null}
            </span>
            <div className={cn("col-start-2 min-w-0 pt-[3px] text-sm md:col-start-3", s.status === "not_checked" ? "text-fg-muted" : "text-fg")}>
              <p>{s.sentence}</p>
              {s.evidence ? <Evidence parts={s.evidence.parts} gold={trace.golds[0]} /> : null}
            </div>
          </li>
        ))}
      </ol>
      {trace.fix && lost ? (
        <div className="flex flex-col gap-2 border-t border-hairline pt-3">
          <h3 className="text-sm font-semibold text-fg">Try a fix</h3>
          <p className="max-w-[68ch] text-sm text-fg">{trace.fix}</p>
          {fixHref ? (
            <a
              href={fixHref}
              className="inline-flex min-h-9 items-center self-start rounded-control bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
            >
              Change {lost.name} on Build
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Evidence({ parts, gold }: { parts: { kind: string; text: string }[]; gold: string | undefined }) {
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-panel bg-surface-raised p-3">
      <p className="text-xs tracking-[0.06em] text-fg-muted uppercase">The parsed text around the answer</p>
      <p className="font-serif text-base leading-[1.75] break-words text-fg">
        {parts.map((p, i) => {
          const gap = i > 0 ? " " : ""
          if (p.kind === "answer")
            return (
              <span key={i}>
                {gap}
                <mark data-part="answer" className="rounded-[3px] bg-kept px-0.5 text-kept-text [box-decoration-break:clone]">
                  {p.text}
                </mark>
              </span>
            )
          if (p.kind === "other")
            return (
              <span key={i}>
                {gap}
                <del data-part="other" className="rounded-[3px] bg-removed px-0.5 text-removed-text decoration-removed-mark [box-decoration-break:clone]">
                  {p.text}
                </del>
              </span>
            )
          return (
            <span key={i} className="text-fg-muted">
              {gap}
              {p.text}
            </span>
          )
        })}
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-3 rounded-[3px] bg-kept" />
          the answer sentence
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-3 rounded-[3px] bg-removed" />
          other text in the middle of it
        </span>
      </p>
      {gold ? (
        <>
          <p className="text-xs tracking-[0.06em] text-fg-muted uppercase">The sentence it looked for</p>
          <p className="font-serif text-sm break-words text-fg">“{gold}”</p>
        </>
      ) : null}
    </div>
  )
}
