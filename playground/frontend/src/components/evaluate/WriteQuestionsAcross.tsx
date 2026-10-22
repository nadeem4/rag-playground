import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { PROVIDER_INFO } from "@/api/apiKey"
import { plainMessage } from "@/api/client"
import type { Registry } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { useRun } from "@/api/useRun"
import { v2 } from "@/api/v2"
import { FileTag } from "@/components/FileTag"
import { SideSheet } from "@/components/SideSheet"
import { Button } from "@/components/ui/button"
import type { FileInfo } from "@/lib/files"
import { documentCounts, type Question } from "@/state/goldSet"
import {
  clampCount,
  DEFAULT_PER_DOCUMENT,
  joinedFilename,
  joinedSet,
  keyNotice,
  MAX_PER_DOCUMENT,
  mergeWritten,
  perDocumentLine,
  reviewItems,
  reviewSummary,
  useWriteSession,
  type ReviewItem,
  type WrittenSet,
} from "@/state/writeQuestions"

import { plural, Review, SetUp, useWriteModel, Writing } from "./WriteQuestions"

/**
 * Write questions for me with several documents (spec "Write questions for me
 * (part 4b)"): pick the documents to write for and how many questions each, and
 * a model writes them one document at a time, each through that document's own
 * generate route. The review is grouped by document, and saving adds the kept
 * questions to the one set: the set as it is, every question in it, plus the
 * new ones, each naming its document, posted through `onSave` (POST
 * /questions), so nothing in it is replaced.
 *
 * Like the one-document sheet, the runs and the review live above the page
 * (`useWriteSession`, keyed by the documents), so closing the sheet keeps them.
 */
export function WriteQuestionsAcross({
  files,
  questions,
  filenames,
  registry,
  locked,
  onSave,
  saveError,
}: {
  files: readonly FileInfo[]
  /** The set as it is now, every question; null while it is read. */
  questions: readonly Question[] | null
  /** The files it was read from, which the joined set's name keeps. */
  filenames: readonly string[]
  registry: Registry
  locked: boolean
  /** Post the joined set for every document; true when it was taken. */
  onSave: (file: File) => Promise<boolean>
  saveError: string | null
}) {
  const [open, setOpen] = useState(false)
  const { keys, setPanelOpen, server, models, model, setPicked } = useWriteModel(registry)
  const demo = useDemo()
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const chosen = files.filter((f) => !unchecked.has(f.sha))
  const [countText, setCountText] = useState(String(DEFAULT_PER_DOCUMENT))
  const per = clampCount(Number(countText), MAX_PER_DOCUMENT)
  const counts = documentCounts(questions ?? [], files.map((f) => f.sha))

  const [session, setSession] = useWriteSession(files.map((f) => f.sha).join(","))
  const { runId, writer, error, written, items, plan, at, stopping } = session
  const [starting, setStarting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const run = useRun(runId)
  const fileOf = (sha: string | undefined) => files.find((f) => f.sha === sha)
  const nameOf = (sha: string) => fileOf(sha)?.filename ?? sha

  const begin = async (sha: string, p: { count: number; model: string }) => {
    setStarting(true)
    try {
      const { run_id } = await v2.generateQuestions(sha, { model: p.model, count: p.count }, { keys })
      setSession({ runId: run_id })
    } catch (err) {
      setSession((s) => ({ error: `${nameOf(sha)}: ${plainMessage(err)}`, plan: s.written ? s.plan : null }))
    } finally {
      setStarting(false)
    }
  }

  // One document's run ended: its questions join the review, then the next
  // document starts, unless Stop was pressed or the run failed. A run that has
  // closed but whose result is not read yet is waited for.
  useEffect(() => {
    if (!runId || !run.closed || !plan) return
    const sha = plan.shas[at]
    const result = run.result as (Partial<WrittenSet> & { error?: string }) | null
    let set: WrittenSet | null = null
    let failed: string | null = null
    if (run.status === "cancelled") failed = null
    else if (result && typeof result.error === "string") failed = result.error
    else if (result && Array.isArray(result.questions))
      set = {
        questions: result.questions.map((q) => ({ ...q, document: sha })),
        dropped: result.dropped ?? [],
        usage: result.usage ?? { input_tokens: null, output_tokens: null, model: null },
      }
    else if (run.resultFailed || run.error) failed = run.error ?? "The questions were written, but they could not be read."
    else return
    const merged = set ? mergeWritten(written, set) : written
    const all = set ? [...items, ...reviewItems(set)] : items
    const next = at + 1
    if (set && !stopping && next < plan.shas.length) {
      setSession({ runId: null, written: merged, items: all, at: next })
      void begin(plan.shas[next], plan)
    } else {
      setSession({
        runId: null,
        written: merged,
        items: all,
        plan: merged ? plan : null,
        stopping: false,
        error: failed ? `${nameOf(sha)}: ${failed}` : null,
      })
    }
    // `begin` and `nameOf` read only props; the run's end is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, run.closed, run.status, run.result, run.resultFailed, run.error])

  const step: "setup" | "writing" | "review" | "error" = runId || starting ? "writing" : written ? "review" : error !== null ? "error" : "setup"

  const write = () => {
    if (!model || !chosen.length) return
    const p = { shas: chosen.map((f) => f.sha), count: per, model: model.id }
    setSession({ error: null, written: null, items: [], plan: p, at: 0, stopping: false, writer: model.label })
    void begin(p.shas[0], p)
  }

  // Asks the current run to stop and starts no further document; what was written so far goes to review.
  const stop = () => {
    setSession({ stopping: true })
    if (runId) void v2.cancelRun(runId).catch(() => undefined)
  }

  const discard = () => {
    setSession({ written: null, items: [], plan: null, at: 0, error: null })
    setSaveFailed(false)
    setOpen(false)
  }

  const save = async () => {
    setSaving(true)
    setSaveFailed(false)
    const file = new File([JSON.stringify(joinedSet(questions ?? [], items), null, 2)], joinedFilename(filenames, writer), { type: "application/json" })
    const ok = await onSave(file)
    setSaving(false)
    if (ok) discard()
    else setSaveFailed(true)
  }

  const update = (i: number, patch: Partial<ReviewItem>) => setSession((s) => ({ items: s.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))

  const sum = reviewSummary(items)
  const footer =
    step === "setup" ? (
      <>
        <span className="mr-auto text-xs text-fg-muted">{model ? "Uses your key" : "Needs your key"}</span>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button disabled={!model || locked || !chosen.length || questions === null} onClick={write}>
          Write {plural(per * chosen.length, "question")}
        </Button>
      </>
    ) : step === "writing" ? (
      <>
        <span className="mr-auto text-xs text-fg-muted">Uses your key</span>
        <Button variant="ghost" disabled={!runId || stopping} onClick={stop}>
          Stop
        </Button>
        <Button busy>Writing</Button>
      </>
    ) : step === "error" ? (
      <Button variant="outline" className="ml-auto" onClick={() => setSession({ error: null })}>
        Back to set up
      </Button>
    ) : (
      <>
        <span className="mr-auto text-xs text-fg-muted">They join your question set</span>
        <Button variant="ghost" onClick={discard}>
          Discard all
        </Button>
        <Button disabled={sum.keep === 0 || saving || locked || questions === null} onClick={() => void save()}>
          Save {plural(sum.keep, "question")}
        </Button>
      </>
    )

  const current = plan ? fileOf(plan.shas[at]) : undefined
  return (
    <>
      <Button variant="outline" size="sm" disabled={locked} onClick={() => setOpen(true)}>
        Write questions for me
      </Button>
      {open
        ? createPortal(
            <SideSheet
              title="Write questions for me"
              medium
              onClose={() => setOpen(false)}
              head={
                <p className="text-xs text-fg-muted">
                  A model reads each document you pick part by part and writes one test question for each part, with the passage that answers it.
                </p>
              }
              footer={footer}
            >
              {step === "setup" ? (
                <SetUp
                  models={models}
                  model={model?.id ?? ""}
                  onModel={setPicked}
                  countText={countText}
                  onCount={setCountText}
                  max={MAX_PER_DOCUMENT}
                  demo={demo}
                  countLabel="Questions per document"
                  provider={model ? PROVIDER_INFO[model.provider].name : null}
                  keyLine={model ? keyNotice(model.provider, server, keys) : ""}
                  onAddKey={() => {
                    setOpen(false)
                    setPanelOpen(true)
                  }}
                  before={
                    <fieldset aria-label="Documents to write for" className="flex flex-col gap-1">
                      <legend className="mb-1 text-sm font-semibold text-fg">Write for</legend>
                      {files.map((f) => (
                        <label key={f.sha} className="flex min-h-[28px] min-w-0 flex-wrap items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!unchecked.has(f.sha)}
                            onChange={(e) =>
                              setUnchecked((u) => {
                                const next = new Set(u)
                                if (e.target.checked) next.delete(f.sha)
                                else next.add(f.sha)
                                return next
                              })
                            }
                          />
                          <FileTag file={f} />
                          <span className="text-xs text-fg-muted">{counts.byDocument[f.sha] ?? 0} in your set</span>
                        </label>
                      ))}
                    </fieldset>
                  }
                  after={
                    <p data-testid="write-total" className="text-xs text-fg">
                      {perDocumentLine(per, chosen.length)}
                    </p>
                  }
                />
              ) : step === "writing" ? (
                <Writing
                  done={run.parts?.number ?? 0}
                  total={run.parts?.total ?? null}
                  queued={run.queued}
                  document={
                    plan ? (
                      <p className="flex flex-wrap items-center gap-2 text-xs text-fg">
                        <span className="tabular-nums">
                          Document {at + 1} of {plan.shas.length}
                        </span>
                        {current ? <FileTag file={current} /> : null}
                        {stopping ? <span className="text-fg-muted">Stopping after this one</span> : null}
                      </p>
                    ) : null
                  }
                />
              ) : step === "error" ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold text-fg">The questions could not be written</h3>
                  <p role="alert" className="text-sm break-words text-danger">
                    {error}
                  </p>
                </div>
              ) : (
                <>
                  {error ? (
                    <p role="alert" className="text-sm break-words text-danger">
                      {error} The questions written before it are below.
                    </p>
                  ) : null}
                  <Review
                    items={items}
                    written={written!}
                    writer={writer}
                    update={update}
                    saveError={saveFailed ? saveError : null}
                    groupOf={(it) => {
                      const f = fileOf(it.document)
                      return f ? <FileTag file={f} /> : (it.document ?? "")
                    }}
                  />
                </>
              )}
            </SideSheet>,
            document.body,
          )
        : null}
    </>
  )
}
