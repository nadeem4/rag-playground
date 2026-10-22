import { useRef, type ReactNode } from "react"
import { Upload } from "lucide-react"

import { api } from "@/api/client"
import type { Registry } from "@/api/types"
import { FileTag } from "@/components/FileTag"
import { Button } from "@/components/ui/button"
import type { FileInfo } from "@/lib/files"
import { acrossLine, documentCounts, type Question, type Report } from "@/state/goldSet"

import { NoDocument } from "./ByDocument"
import { UploadReport } from "./QuestionSetPanel"
import { WriteQuestions } from "./WriteQuestions"

/**
 * The question set of a pipeline with several documents (spec "Evaluate
 * (part 4a)"): one set for all of them. It says where the questions came from
 * and how many name each document, then how many name none, which count as
 * found in any document. Upload another set replaces it for every document.
 * Write questions for me opens the same sheet as with one document, for the
 * first document. With one document, `QuestionSetPanel` is shown instead.
 */
export function QuestionSetAcross({
  files,
  questions,
  filenames,
  fromSamples,
  registry,
  report,
  tabOnly,
  error,
  busy,
  disabled,
  onUpload,
  onSaveWritten,
  extra,
}: {
  files: readonly FileInfo[]
  questions: readonly Question[] | null
  filenames: readonly string[]
  /** The questions are the bundled samples' own sets. */
  fromSamples: boolean
  registry: Registry
  report: Report | null
  tabOnly: boolean
  error: string | null
  busy: boolean
  /** A run is in flight, so the set must not change under it. */
  disabled: boolean
  onUpload: (file: File) => Promise<boolean>
  onSaveWritten: (file: File) => Promise<boolean>
  /** A quiet sentence under the list, such as what found means at this k. */
  extra?: ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const locked = busy || disabled
  const counts = questions ? documentCounts(questions, files.map((f) => f.sha)) : null
  const named = counts ? files.filter((f) => counts.byDocument[f.sha] > 0).length : 0
  const plural = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`
  const line = !questions
    ? "Reading the question set"
    : !questions.length
      ? "No question set yet"
      : fromSamples
        ? acrossLine(questions.length, ["the samples"], named, files.length)
        : acrossLine(questions.length, filenames, named, files.length)

  return (
    <section aria-label="Question set" data-testid="question-set-across" className="flex max-w-[48rem] flex-col gap-2 rounded-panel border border-hairline bg-surface-raised p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">Question set</h2>
        {questions?.length ? <span className="text-xs text-fg-muted">{plural(questions.length)}</span> : null}
      </div>
      <p data-testid="set-line" className="text-sm text-fg">
        {line}
      </p>
      {counts && questions?.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {files.map((f) => (
            <li key={f.sha} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline py-2 first:border-t-0">
              <FileTag file={f} />
              <span className="text-sm">
                <strong className="font-semibold">{plural(counts.byDocument[f.sha])}</strong>
              </span>
            </li>
          ))}
          {counts.unnamed ? (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline py-2">
              <NoDocument />
              <span className="text-sm">
                <strong className="font-semibold">{plural(counts.unnamed)}</strong>, found in any document
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className="sr-only"
          aria-label="Upload a question set"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onUpload(file)
            e.target.value = ""
          }}
        />
        <Button variant="outline" size="sm" disabled={locked} onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden strokeWidth={1.75} />
          {questions?.length && !fromSamples ? "Upload another set" : "Upload a question set"}
        </Button>
        <WriteQuestions sha={files[0].sha} filename={files[0].filename} registry={registry} locked={locked} saveError={error} onSave={onSaveWritten} />
        <a className="inline-flex min-h-[28px] items-center text-sm text-fg underline underline-offset-4" href={api.questionTemplateUrl("csv")} download>
          Start from the template
        </a>
      </div>
      <p className="max-w-[70ch] text-xs text-fg-muted">
        One JSON or CSV file for all the documents. Its optional <code className="font-mono">document</code> column names each question's file, such as{" "}
        <span className="font-mono">{files[files.length - 1].filename}</span>. Leave it empty and the question counts as found in any document.
      </p>
      {extra ? <p className="text-xs text-fg-muted">{extra}</p> : null}
      {tabOnly ? (
        <p data-testid="tab-only" className="text-xs text-fg-muted">
          This set is kept in this browser tab only. The server would not store it, so it goes when you close the tab.
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="set-error" className="text-xs break-words text-danger">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-fg-muted">
          Checking the set against the documents
        </p>
      ) : null}
      {report ? <UploadReport report={report} /> : null}
    </section>
  )
}
