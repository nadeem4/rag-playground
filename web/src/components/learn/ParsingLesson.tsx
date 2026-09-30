import { useState } from "react"

import type { Registry } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  CLOSING,
  LAB,
  missingExcerpt,
  PARSER_LABEL,
  PARSERS,
  perPage,
  RECAP,
  RULES,
  runLink,
  SITUATION,
  verdict,
  type LabCase,
  type ParserId,
} from "@/learn/parsing"
import { cn } from "@/lib/utils"

import { LessonShell, type LessonStep } from "./LessonShell"

/**
 * Learn > Choosing a parser: three kinds of PDF, one step each. The learner
 * picks a parser, then sees what both parsers really did on the bundled
 * sample, as recorded in `learn/parsing-lab.json`. There is no wrong answer,
 * only a measured trade-off. A fourth step puts the three cases side by side.
 */

export interface ParsingLessonProps {
  registry: Registry
}

/** Seconds per page as the tables show it. */
const seconds = (n: number) => (n === 0 ? "under 0.1" : String(n))

const TH = "border-b border-hairline px-2 py-1 text-left font-medium"
const TD = "border-b border-hairline px-2 py-1"

export function ParsingLesson({ registry }: ParsingLessonProps) {
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<Partial<Record<string, ParserId>>>({})

  const steps: LessonStep[] = [
    ...LAB.cases.map((c) => ({
      id: c.name,
      title: c.title,
      body: <Case c={c} registry={registry} pick={picks[c.name] ?? null} onPick={(p) => setPicks((all) => ({ ...all, [c.name]: p }))} />,
    })),
    { id: "which", title: "When to choose which", body: <Which /> },
  ]

  // The document beside a case step is that case's sample; after the cases, the first one.
  const shown = LAB.cases[step < LAB.cases.length ? step : 0]
  const document = { filename: shown.filename, pages: shown.pages, caption: `${shown.title}, ${shown.pages} pages. Pick a parser, then see what each one read.` }

  return (
    <LessonShell
      title="Choosing a parser"
      slug="parsing"
      sha={shown.sha}
      document={document}
      steps={steps}
      step={step}
      onStep={setStep}
      recap={RECAP}
    />
  )
}

function Case({ c, registry, pick, onPick }: { c: LabCase; registry: Registry; pick: ParserId | null; onPick: (p: ParserId) => void }) {
  const other = pick === "pdfium" ? "docling" : "pdfium"
  const better = pick !== null && c.parsers[pick].hits > c.parsers[other].hits
  return (
    <>
      <p className="m-0 max-w-[68ch] text-base leading-[1.65]">{SITUATION[c.name]}</p>
      <section aria-label="Your choice" aria-live="polite" className="flex min-w-0 flex-col gap-3 rounded-panel border border-hairline bg-surface p-4">
        <p className="m-0 text-base font-semibold">Which parser do you pick?</p>
        <div className="flex flex-wrap gap-2">
          {PARSERS.map((p) => (
            <Button
              key={p}
              variant="outline"
              disabled={pick !== null}
              aria-pressed={pick === p}
              className={cn(pick === p && "border-fg-muted bg-surface-elevated")}
              onClick={() => onPick(p)}
            >
              {PARSER_LABEL[p]}
            </Button>
          ))}
        </div>
      </section>
      {pick ? (
        <>
          <MeasuredTable c={c} />
          <section aria-label="Around the first answer" className="flex min-w-0 flex-col gap-2">
            <h3 className="m-0 text-lg font-semibold">Around the first answer</h3>
            {PARSERS.map((p) => (
              <div key={p} className="flex min-w-0 flex-col gap-1">
                <p className="m-0 text-sm font-medium">{PARSER_LABEL[p]}</p>
                {c.parsers[p].excerpt ? (
                  <p className="m-0 rounded-panel border border-hairline bg-surface-elevated p-2 font-mono text-xs break-words">{c.parsers[p].excerpt}</p>
                ) : (
                  <p className="m-0 text-sm text-fg-muted">{missingExcerpt(c.parsers[p])}</p>
                )}
              </div>
            ))}
          </section>
          <div className={cn("rounded-panel p-3 text-sm", better ? "bg-kept text-kept-text" : "bg-surface-elevated")}>
            <p className="m-0">{verdict(c, pick)}</p>
          </div>
          <section aria-label="Run it yourself" className="flex min-w-0 flex-col gap-2">
            <h3 className="m-0 text-lg font-semibold">Run it yourself</h3>
            <p className="m-0 text-sm text-fg-muted">Each link opens Build with this sample and its first question, ready to run.</p>
            <div className="flex flex-wrap gap-2">
              {PARSERS.map((p) => (
                <Button key={p} asChild variant="outline">
                  <a href={runLink(registry, c, p)}>Run it with {PARSER_LABEL[p]}</a>
                </Button>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </>
  )
}

function MeasuredTable({ c }: { c: LabCase }) {
  return (
    <table className="w-full max-w-[68ch] border-collapse text-sm">
      <caption className="pb-1 text-left text-xs text-fg-muted">Measured on {c.pages} pages</caption>
      <thead>
        <tr>
          <th className={TH}>Parser</th>
          <th className={TH}>Seconds per page</th>
          <th className={TH}>Characters kept</th>
          <th className={TH}>Questions answered</th>
        </tr>
      </thead>
      <tbody>
        {PARSERS.map((p) => (
          <tr key={p}>
            <td className={TD}>{PARSER_LABEL[p]}</td>
            <td className={cn(TD, "font-mono")}>{seconds(perPage(c.parsers[p], c.pages))}</td>
            <td className={cn(TD, "font-mono")}>{c.parsers[p].chars}</td>
            <td className={cn(TD, "font-mono")}>{`${c.parsers[p].hits} of ${c.questions}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Which() {
  return (
    <>
      <table className="w-full max-w-[68ch] border-collapse text-sm">
        <caption className="pb-1 text-left text-xs text-fg-muted">The three samples, side by side</caption>
        <thead>
          <tr>
            <th className={TH}>Sample</th>
            <th className={TH}>Parser</th>
            <th className={TH}>Seconds per page</th>
            <th className={TH}>Questions answered</th>
          </tr>
        </thead>
        <tbody>
          {LAB.cases.flatMap((c) =>
            PARSERS.map((p) => (
              <tr key={`${c.name}-${p}`}>
                <td className={TD}>{c.title}</td>
                <td className={TD}>
                  {PARSER_LABEL[p]}
                  {c.parsers[p].ocr ? <span className="text-fg-muted"> with OCR</span> : null}
                </td>
                <td className={cn(TD, "font-mono")}>{seconds(perPage(c.parsers[p], c.pages))}</td>
                <td className={cn(TD, "font-mono")}>{`${c.parsers[p].hits} of ${c.questions}`}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <ul className="m-0 flex max-w-[68ch] flex-col gap-2 pl-4 text-base leading-[1.65]">
        {RULES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="m-0 max-w-[68ch] text-base leading-[1.65]">{CLOSING}</p>
    </>
  )
}
