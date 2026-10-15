import { Fragment, useEffect, useId, useMemo, useState } from "react"

import { api } from "@/api/client"
import type { Registry } from "@/api/types"
import { SideSheet } from "@/components/SideSheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AskQuestion } from "@/state/config"
import { useDocument, type DocRef } from "@/state/document"
import type { PipelineGraph } from "@/state/graph"
import {
  appliedLine,
  COMING_NEXT,
  composeConfig,
  composedRows,
  DOCUMENT_ORDER,
  orderTemplates,
  QUESTION_ORDER,
  stepsLine,
  templatePipeline,
  type PipelineTemplates,
} from "@/state/templates"

/** What "Use this pipeline" hands Build: the column, any dropped settings, and the status line. */
export type UsedTemplate = { graph: PipelineGraph; note?: string; line: string }

/**
 * Start from a template, on Build: pick what the documents are like and what
 * will be asked, see the pipeline the two make, and use it. The templates come
 * from `GET /api/templates`; only the Tables across pages card is the
 * playground's own, shown disabled until it ships. Using one keeps the
 * documents and the question already in use.
 */
export function TemplatePicker({
  registry,
  current,
  onUse,
  onClose,
}: {
  registry: Registry
  current: { documents: DocRef[]; question: AskQuestion }
  onUse: (used: UsedTemplate) => void
  onClose: () => void
}) {
  const id = useId()
  const { samples } = useDocument()
  const [templates, setTemplates] = useState<PipelineTemplates | null>(null)
  const [failed, setFailed] = useState(false)
  const [docId, setDocId] = useState<string | null>(null)
  const [questionId, setQuestionId] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .templates()
      .then((t) => live && setTemplates(t))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  const docs = useMemo(() => orderTemplates(templates?.documents ?? [], DOCUMENT_ORDER), [templates])
  const questions = useMemo(() => orderTemplates(templates?.questions ?? [], QUESTION_ORDER), [templates])
  const doc = docs.find((t) => t.id === docId) ?? docs[0]
  const question = questions.find((t) => t.id === questionId) ?? questions[0]
  const rows = doc && question ? composedRows(composeConfig(doc, question)) : []
  const made = doc && question ? templatePipeline(doc, question, current, registry) : null
  const sample = doc ? (samples?.find((s) => s.name === doc.sample)?.title ?? null) : null

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>
        Keep my current pipeline
      </Button>
      <Button
        disabled={!made?.ok}
        onClick={() => {
          if (!made?.ok || !doc || !question) return
          onUse({ graph: made.graph, note: made.note, line: appliedLine(doc.name, question.name, rows.length) })
        }}
      >
        Use this pipeline
      </Button>
    </>
  )

  return (
    <SideSheet title="Start from a template" onClose={onClose} footer={footer} wide>
      <p className="text-sm text-fg-muted">
        Pick what your documents look like and what you will ask. Together they make one pipeline you can run, change and save.
      </p>
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          The templates could not be loaded. Close this and try again.
        </p>
      ) : !templates ? (
        <p role="status" className="text-sm text-fg-muted">
          Getting the templates ready.
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_36rem] flex-col gap-6">
            <CardSet title="1. What are your documents like?" hint="Sets parse, clean, chunk, embed and store" id={`${id}-docs`}>
              {docs.map((t, i) => (
                <Fragment key={t.id}>
                  {/* Coming next sits third, after Reports with tables, as in the approved design. */}
                  {i === 2 ? <TemplateCard name={COMING_NEXT.name} summary={COMING_NEXT.summary} goodFor={COMING_NEXT.good_for} soon /> : null}
                  <TemplateCard
                    name={t.name}
                    summary={t.summary}
                    goodFor={t.good_for}
                    steps={stepsLine(t.pipeline)}
                    picked={t.id === doc?.id}
                    onPick={() => setDocId(t.id)}
                  />
                </Fragment>
              ))}
            </CardSet>
            <CardSet title="2. What will you ask?" hint="Sets rewrite, search, rerank and the answer" id={`${id}-questions`}>
              {questions.map((t) => (
                <TemplateCard
                  key={t.id}
                  name={t.name}
                  summary={t.summary}
                  goodFor={t.good_for}
                  steps={stepsLine(t.pipeline)}
                  picked={t.id === question?.id}
                  needsKey={t.needs_key}
                  onPick={() => setQuestionId(t.id)}
                />
              ))}
            </CardSet>
          </div>
          {doc && question ? (
            <section
              aria-labelledby={`${id}-yours`}
              className="flex min-w-0 flex-[1_1_18rem] flex-col gap-3 rounded-control border border-hairline bg-surface p-4"
            >
              <h3 id={`${id}-yours`} className="font-serif text-lg font-semibold text-fg">
                Your pipeline
              </h3>
              <p className="text-sm text-fg">
                <strong>{doc.name}</strong> with <strong>{question.name}</strong>
              </p>
              <ol className="flex flex-col border-t border-hairline">
                {rows.map((r) => (
                  <li key={r.stage} className="flex justify-between gap-3 border-b border-hairline py-2 text-sm">
                    <span className="text-fg-muted">{r.stage}</span>
                    <span className="min-w-0 text-right font-mono text-xs break-words text-fg">{r.use}</span>
                  </li>
                ))}
              </ol>
              {question.needs_key ? (
                <p className="rounded-control bg-warn px-3 py-2 text-sm text-warn-text">
                  This pipeline calls a language model. Add your key in Settings before you Ask.
                </p>
              ) : null}
              <p className="text-sm text-fg-muted">
                Try it on the sample {sample ? <span className="text-fg">{sample}</span> : <span className="font-mono text-xs text-fg">{doc.sample}</span>}, or add your own document.
              </p>
              {made && !made.ok ? (
                <p role="alert" className="text-sm text-danger">
                  {made.problem}
                </p>
              ) : null}
              <p className="text-xs text-fg-muted">Your current pipeline is not lost: save it to the Library first, or press Undo after.</p>
            </section>
          ) : null}
        </div>
      )}
    </SideSheet>
  )
}

function CardSet({ title, hint, id, children }: { title: string; hint: string; id: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={id} className="text-base font-semibold text-fg">
          {title}
        </h3>
        <span className="text-xs text-fg-muted">{hint}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">{children}</div>
    </div>
  )
}

function TemplateCard({
  name,
  summary,
  goodFor,
  steps,
  picked = false,
  needsKey = false,
  soon = false,
  onPick,
}: {
  name: string
  summary: string
  goodFor: string
  steps?: string
  picked?: boolean
  needsKey?: boolean
  soon?: boolean
  onPick?: () => void
}) {
  const badge = "shrink-0 rounded-full px-2 py-0.5 text-xs"
  return (
    <button
      type="button"
      aria-pressed={soon ? undefined : picked}
      disabled={soon}
      onClick={onPick}
      className={cn(
        "flex min-h-[2.75rem] flex-col gap-2 rounded-control border bg-surface p-4 text-left text-fg transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)",
        picked ? "border-primary bg-accent-wash" : "border-hairline hover:bg-muted",
        soon && "cursor-default border-dashed opacity-70",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold">{name}</span>
        {soon ? <span className={cn(badge, "bg-muted text-fg-muted")}>Coming next</span> : null}
        {needsKey ? <span className={cn(badge, "bg-warn text-warn-text")}>Needs a key</span> : null}
        {picked ? <span className={cn(badge, "bg-primary text-primary-foreground")}>Picked</span> : null}
      </span>
      <span className="text-sm text-fg-muted">{summary}</span>
      <span className="text-xs text-fg-muted">
        <strong className="font-semibold text-fg">Good for:</strong> {goodFor}
      </span>
      {steps ? <span className="font-mono text-xs break-words text-fg-muted">{steps}</span> : null}
    </button>
  )
}
