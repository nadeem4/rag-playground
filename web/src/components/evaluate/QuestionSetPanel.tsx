import { useId, useRef } from "react"
import { Upload } from "lucide-react"

import { api } from "@/api/client"
import type { StoredQuestionSet } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { EvidenceSlip } from "@/components/inspectors/EvidenceSlip"
import type { HitRowData } from "@/components/inspectors/hits"
import { Button } from "@/components/ui/button"
import { mismatch, reportLines, type InUse, type Report } from "@/state/goldSet"

/**
 * Which question set this page is about to score, and everything you can do
 * about it (plan I-33): upload your own, start from the template, or go back to
 * a bundled sample's own set.
 *
 * The warning is the point of the panel, and it is only ever about a set that
 * IS in play but was written for a different document: a set uploaded for
 * another document scores nothing useful. A document that matches no bundled
 * sample and has nothing uploaded is a different situation (there is simply no
 * set to score with), and Evaluate says that plainly elsewhere without this
 * warning, which is why the sample branch never renders here.
 */

const REPO = "https://github.com/nadeem4/rag-playground"

export function QuestionSetPanel({
  inUse,
  set,
  count,
  filename,
  sampleName,
  report,
  tabOnly,
  error,
  busy,
  disabled,
  onUpload,
  onRemove,
}: {
  inUse: InUse
  set: StoredQuestionSet | null
  /** Questions this set would ask. */
  count: number | null
  /** The document loaded on Build. */
  filename: string
  /** The title of the bundled sample matching the loaded document, if any. */
  sampleName: string | null
  report: Report | null
  tabOnly: boolean
  error: string | null
  busy: boolean
  /** A run is in flight, so the set must not change under it. */
  disabled: boolean
  onUpload: (file: File) => void
  onRemove: () => void
}) {
  const id = useId()
  const demo = useDemo()
  const fileRef = useRef<HTMLInputElement>(null)
  const uploaded = inUse.kind === "uploaded"
  // A "sample" mismatch only ever means "no bundled set matches this
  // document", which is not a warning about a wrong set in play: Evaluate
  // already says so, without alarm, elsewhere on the page.
  const warning = uploaded ? mismatch(inUse, filename) : null
  const locked = busy || disabled
  // No sample matches and nothing is uploaded: there is no set at all, which
  // Evaluate already says elsewhere on the page (F4). This panel must not
  // contradict that by claiming a built-in set is scoring the document.
  const noSet = !(uploaded && set) && sampleName === null

  const pick = (
    <>
      <input
        ref={fileRef}
        id={`${id}-file`}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        className="sr-only"
        aria-label="Upload a question set"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onUpload(file)
          e.target.value = ""
        }}
      />
      <Button variant="outline" size="sm" disabled={locked} onClick={() => fileRef.current?.click()}>
        <Upload aria-hidden strokeWidth={1.75} />
        {uploaded ? "Upload another set" : "Upload a question set"}
      </Button>
    </>
  )

  return (
    <section aria-label="Question set" data-testid="question-set" className="flex shrink-0 flex-col gap-2 border-b border-hairline px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-fg-muted">
          {noSet ? (
            <>
              <span data-testid="set-name" className="font-medium text-fg">
                No question set yet
              </span>
              .
            </>
          ) : (
            <>
              Scoring {uploaded && set ? "" : "the questions for "}
              <span data-testid="set-name" className="font-medium text-fg">
                {uploaded && set ? set.filename : sampleName}
              </span>
              {count === null ? "" : `, ${count} ${count === 1 ? "question" : "questions"}`}.
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {pick}
          {uploaded ? (
            <Button variant="outline" size="sm" disabled={locked} onClick={onRemove}>
              Remove this set
            </Button>
          ) : null}
          <span className="text-xs text-fg-muted">
            Template as{" "}
            <a className="text-fg underline" href={api.questionTemplateUrl("json")} download>
              JSON
            </a>{" "}
            or{" "}
            <a className="text-fg underline" href={api.questionTemplateUrl("csv")} download>
              CSV
            </a>
          </span>
        </div>
      </div>

      {tabOnly ? (
        <p data-testid="tab-only" className="text-xs text-fg-muted">
          This set is kept in this browser tab only. The server would not store it, so it goes when you close the tab.
        </p>
      ) : demo && !uploaded ? (
        <p data-testid="demo-note" className="text-xs text-fg-muted">
          This hosted demo does not store question sets, so an uploaded set would not last.{" "}
          <a href={REPO} target="_blank" rel="noreferrer" className="text-fg underline">
            Run the playground locally
          </a>{" "}
          to evaluate your own document with your own questions.
        </p>
      ) : null}

      {warning ? (
        <div
          role="alert"
          data-testid="set-mismatch"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-panel bg-warn px-3 py-2"
        >
          <p className="text-sm text-warn-text">{warning.text}</p>
          {warning.fix === "upload" ? (
            <Button variant="outline" size="sm" disabled={locked} onClick={() => fileRef.current?.click()}>
              Upload a question set
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={locked} onClick={onRemove}>
              Remove this set
            </Button>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="set-error" className="text-xs break-words text-danger">
          {error}
        </p>
      ) : null}

      {busy ? (
        <p role="status" className="text-xs text-fg-muted">
          Checking the set against the document
        </p>
      ) : null}

      {report ? <UploadReport report={report} /> : null}
    </section>
  )
}

/**
 * The closest text has no rank, no score and no page, so the slip's finding and
 * meta lines would only say invented things ("1st", "score 0.000"). EvidenceSlip
 * has no prop to leave them out yet, so they are hidden here.
 */
const BARE = "[&_[data-testid=finding]]:hidden [&_[data-testid=meta]]:hidden"

/** The upload check gives only the text, so the slip's row is the text and nothing else: no scores, no page. */
function closestRow(text: string): HitRowData {
  return {
    rank: 1,
    score: 0,
    prior_rank: null,
    prior_score: null,
    retriever: "",
    component_scores: {},
    chunk_id: "closest",
    text,
    page_span: null,
    element_ids: null,
    ordinal: null,
    section: null,
  }
}

/**
 * What the upload check found. A set with problems can still be used, so this
 * is a report and not a refusal, and it stays on screen until the set changes.
 */
function UploadReport({ report }: { report: Report }) {
  const lines = reportLines(report)
  return (
    <details open data-testid="upload-report" className="rounded-panel border border-hairline">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium hover:bg-muted">
        {lines[0]} {lines[1]}
      </summary>
      <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2">
        {lines.slice(2).map((line) => (
          <p key={line} className="text-xs text-fg-muted">
            {line}
          </p>
        ))}
        {report.problems.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {report.problems.map((p, i) => (
              <li key={`${p.question}-${i}`} className="flex min-w-0 flex-col gap-1 border-t border-hairline pt-2">
                <p className="text-sm text-fg">{p.question}</p>
                <p className="meta">written in the file</p>
                <p className="font-serif text-base break-words text-fg">{p.gold_answer}</p>
                <p className="meta">closest text in the document</p>
                {p.closest ? (
                  <EvidenceSlip row={closestRow(p.closest)} side="single" piece={null} scaleKey="score" className={BARE} />
                ) : (
                  <p className="text-sm break-words text-fg-muted">Nothing close enough to show.</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  )
}
