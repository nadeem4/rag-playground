import { useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"

import { PROVIDER_INFO, useApiKey } from "@/api/apiKey"
import { ApiError } from "@/api/client"
import { QUEUED_LINE } from "@/api/runState"
import type { Registry } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { useRun } from "@/api/useRun"
import { v2 } from "@/api/v2"
import { CONTROL } from "@/components/fields/types"
import { SideSheet } from "@/components/SideSheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  chatModels,
  clampCount,
  DEFAULT_COUNT,
  defaultModel,
  DEMO_MAX_COUNT,
  keptSet,
  LOCAL_MAX_COUNT,
  reviewItems,
  reviewSummary,
  usageLine,
  writtenFilename,
  type ReviewItem,
  type WrittenSet,
} from "@/state/writeQuestions"

/**
 * Write questions for me, the button after Upload a question set and its sheet: a model reads the document and writes test questions
 * with their evidence, on the visitor's own key, as a run. The sheet has three
 * steps: set up, writing (the run's `part_finished` events) and review. The
 * questions kept are saved through the same upload a file goes through.
 *
 * The run and the review live here, not in the sheet, so closing the sheet
 * neither cancels the run nor loses the review: opening it again shows them.
 */

/** A refusal's own sentence, without the status and path an `ApiError` message starts with. */
const plain = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

export function WriteQuestions({
  sha,
  filename,
  registry,
  locked,
  onSave,
  saveError,
}: {
  sha: string
  /** The document's file name, which the sheet names and the saved set is for. */
  filename: string
  registry: Registry
  /** Upload is disabled (a run or an upload in flight), so this is too. */
  locked: boolean
  /** Upload the kept questions as a file; true when it was kept. */
  onSave: (file: File) => Promise<boolean>
  /** Why the last upload failed, in plain words. */
  saveError: string | null
}) {
  const [open, setOpen] = useState(false)
  const { keys, setPanelOpen } = useApiKey()
  const demo = useDemo()
  const models = chatModels(registry, keys)
  const [picked, setPicked] = useState<string | null>(null)
  const model = models.find((m) => m.id === picked) ?? models.find((m) => m.id === defaultModel(models)) ?? null
  const max = demo ? DEMO_MAX_COUNT : LOCAL_MAX_COUNT
  const [countText, setCountText] = useState(String(DEFAULT_COUNT))
  const count = clampCount(Number(countText), max)

  const [runId, setRunId] = useState<string | null>(null)
  /** The model the run in flight (or the review) was written by. */
  const [writer, setWriter] = useState<string>("")
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [written, setWritten] = useState<WrittenSet | null>(null)
  const [items, setItems] = useState<ReviewItem[]>([])
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const run = useRun(runId)

  // The run ended: its set goes to review, its error to the sheet, a cancel back to set up.
  useEffect(() => {
    if (!runId || !run.closed) return
    const result = run.result as (Partial<WrittenSet> & { error?: string }) | null
    if (run.status === "cancelled") {
      setRunId(null)
    } else if (result && typeof result.error === "string") {
      setError(result.error)
      setRunId(null)
    } else if (result && Array.isArray(result.questions)) {
      const set: WrittenSet = { questions: result.questions, dropped: result.dropped ?? [], usage: result.usage ?? { input_tokens: null, output_tokens: null, model: null } }
      setWritten(set)
      setItems(reviewItems(set))
      setRunId(null)
    } else if (run.resultFailed || run.error) {
      setError(run.error ?? "The questions were written, but they could not be read. Write them again.")
      setRunId(null)
    }
  }, [runId, run.closed, run.status, run.result, run.resultFailed, run.error])

  const step: "setup" | "writing" | "review" | "error" = written ? "review" : error !== null && !starting && runId === null ? "error" : runId || starting ? "writing" : "setup"

  const write = async () => {
    if (!model) return
    setStarting(true)
    setError(null)
    try {
      const { run_id } = await v2.generateQuestions(sha, { model: model.id, count }, { keys })
      setWriter(model.label)
      setRunId(run_id)
    } catch (err) {
      setError(plain(err))
    } finally {
      setStarting(false)
    }
  }

  const stop = () => {
    if (runId) void v2.cancelRun(runId).catch(() => undefined)
    setRunId(null)
  }

  const discard = () => {
    setWritten(null)
    setItems([])
    setSaveFailed(false)
    setOpen(false)
  }

  const save = async () => {
    setSaving(true)
    setSaveFailed(false)
    const file = new File([JSON.stringify(keptSet(items, filename), null, 2)], writtenFilename(writer), { type: "application/json" })
    const ok = await onSave(file)
    setSaving(false)
    if (ok) discard()
    else setSaveFailed(true)
  }

  const update = (i: number, patch: Partial<ReviewItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const sum = reviewSummary(items)
  const footer =
    step === "setup" ? (
      <>
        <span className="mr-auto text-xs text-fg-muted">{model ? "Uses your key" : "Needs your key"}</span>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button disabled={!model || locked} onClick={() => void write()}>
          Write {plural(count, "question")}
        </Button>
      </>
    ) : step === "writing" ? (
      <>
        <span className="mr-auto text-xs text-fg-muted">Uses your key</span>
        <Button variant="ghost" disabled={!runId} onClick={stop}>
          Stop
        </Button>
        <Button busy>Writing</Button>
      </>
    ) : step === "error" ? (
      <Button variant="outline" className="ml-auto" onClick={() => setError(null)}>
        Back to set up
      </Button>
    ) : (
      <>
        <span className="mr-auto text-xs text-fg-muted">Saved as your question set for this document</span>
        <Button variant="ghost" onClick={discard}>
          Discard all
        </Button>
        <Button disabled={sum.keep === 0 || saving || locked} onClick={() => void save()}>
          Save {plural(sum.keep, "question")}
        </Button>
      </>
    )

  return (
    <>
      <span className="text-xs text-fg-muted">or</span>
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
                  A model reads <strong className="font-semibold break-words text-fg">{filename}</strong> part by part and writes one test question for each
                  part, with the passage that answers it.
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
                  max={max}
                  demo={demo}
                  provider={model ? PROVIDER_INFO[model.provider].name : null}
                  onAddKey={() => {
                    setOpen(false)
                    setPanelOpen(true)
                  }}
                  error={error}
                />
              ) : step === "writing" ? (
                <Writing done={run.parts?.number ?? 0} total={run.parts?.total ?? null} queued={run.queued} />
              ) : step === "error" ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold text-fg">The questions could not be written</h3>
                  <p role="alert" className="text-sm break-words text-danger">
                    {error}
                  </p>
                </div>
              ) : (
                <Review
                  items={items}
                  written={written!}
                  writer={writer}
                  update={update}
                  saveError={saveFailed ? saveError : null}
                />
              )}
            </SideSheet>,
            document.body,
          )
        : null}
    </>
  )
}

function SetUp({
  models,
  model,
  onModel,
  countText,
  onCount,
  max,
  demo,
  provider,
  onAddKey,
  error,
}: {
  models: ReturnType<typeof chatModels>
  model: string
  onModel: (id: string) => void
  countText: string
  onCount: (text: string) => void
  max: number
  demo: boolean
  provider: string | null
  onAddKey: () => void
  error: string | null
}) {
  const id = useId()
  return (
    <>
      {provider ? (
        <div className="flex flex-col gap-1 rounded-control bg-warn px-3 py-2 text-warn-text">
          <p className="text-sm font-semibold">This way, you're going to use your key.</p>
          <p className="text-xs">
            Each part is one call to the model on your {provider} key, so you pay for it. 20 questions with Claude Sonnet 5 used about 8,700 tokens in and
            2,700 out in our test. The key stays in this browser and is sent only with this request.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1 rounded-control bg-surface-elevated px-3 py-2">
          <p className="text-sm font-semibold text-fg">Add a key first.</p>
          <p className="text-xs text-fg">
            Writing questions calls a model on your own key, so you pay for it, not the demo. Add an Anthropic or OpenAI key with the Key button at the top of
            the page, then come back.
          </p>
          <Button variant="outline" size="sm" onClick={onAddKey}>
            Add a key
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        {models.length ? (
          <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
            <label htmlFor={`${id}-model`} className="text-sm font-semibold text-fg">
              Model
            </label>
            <select id={`${id}-model`} className={CONTROL} value={model} onChange={(e) => onModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {/haiku/i.test(m.id) ? " (cheapest)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-count`} className="text-sm font-semibold text-fg">
            Questions
          </label>
          <input
            id={`${id}-count`}
            type="number"
            min={1}
            max={max}
            value={countText}
            onChange={(e) => onCount(e.target.value)}
            className={cn(CONTROL, "w-24 font-mono tabular-nums")}
          />
          <span className="text-xs text-fg-muted">{demo ? `At most ${max} here.` : `At most ${max} at a time.`}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1 rounded-control bg-surface-elevated px-3 py-2 text-xs text-fg">
        <p>
          <strong className="font-semibold">What gets checked for you.</strong> Every question must come with a passage copied word for word from the document. A
          question whose passage is not found, is only a heading, or repeats another question is dropped, and you see why. A question that reuses most of its
          passage's words is marked <em>copied</em>, because it is easier to find than a real question would be.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm break-words text-danger">
          {error}
        </p>
      ) : null}
    </>
  )
}

function Writing({ done, total, queued }: { done: number; total: number | null; queued: boolean }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">Writing questions</h3>
      <div
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={total ?? undefined}
        aria-valuenow={total === null ? undefined : done}
        className="h-2 overflow-hidden rounded-full bg-surface-elevated"
      >
        <span className="block h-full bg-primary transition-[width]" style={{ width: total ? `${(100 * done) / total}%` : "0%" }} />
      </div>
      <p id={id} aria-live="polite" className="text-xs text-fg tabular-nums">
        {queued ? QUEUED_LINE : total === null ? "Starting the first part." : `Part ${done} of ${total} done.`}
      </p>
      <p className="text-xs text-fg-muted">This takes about a minute for 20. You can close this and keep working; the questions wait for you here.</p>
    </div>
  )
}

const TAG = "rounded-full px-2 text-xs whitespace-nowrap"

function Review({
  items,
  written,
  writer,
  update,
  saveError,
}: {
  items: ReviewItem[]
  written: WrittenSet
  writer: string
  update: (i: number, patch: Partial<ReviewItem>) => void
  saveError: string | null
}) {
  const sum = reviewSummary(items)
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <p data-testid="review-summary" aria-live="polite" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg tabular-nums">
        <span>
          <strong className="font-semibold">{sum.keep}</strong> to keep
        </span>
        <span>{sum.dropped} dropped by you</span>
        <span>{sum.copied} marked copied</span>
        <span>{sum.edited} edited</span>
        <span className="text-fg-muted">{usageLine(writer, written.usage)}</span>
      </p>
      <p className="text-xs text-fg-muted">
        Read each question as a user would ask it. Keep the good ones, fix the wording of the near misses, and drop the rest. Nothing is saved until you press
        Save.
      </p>
      {saveError ? (
        <p role="alert" className="text-sm break-words text-danger">
          {saveError}
        </p>
      ) : null}
      {items.length === 0 ? <p className="text-sm text-fg">The model wrote no question that passed the checks.</p> : null}
      <ol data-testid="review-list" className="flex flex-col gap-2">
        {items.map((it, i) => {
          const isEditing = editing?.i === i
          return (
            <li
              key={it.id || i}
              className={cn("flex flex-col gap-1 rounded-panel border border-hairline px-3 py-2", it.dropped ? "bg-surface-elevated" : "bg-surface-raised")}
            >
              <div className="flex items-baseline gap-2">
                <span className="w-6 shrink-0 font-mono text-xs text-fg-muted">{i + 1}</span>
                {isEditing ? (
                  <textarea
                    aria-label={`Question ${i + 1}`}
                    className={cn(CONTROL, "h-auto min-h-16 py-1")}
                    value={editing.text}
                    onChange={(e) => setEditing({ i, text: e.target.value })}
                  />
                ) : (
                  <span className={cn("min-w-0 flex-1 text-sm font-medium break-words", it.dropped ? "text-fg-muted line-through" : "text-fg")}>{it.question}</span>
                )}
                <span className="flex flex-wrap gap-1">
                  {it.tags.includes("copied") ? (
                    <span className={cn(TAG, "bg-warn text-warn-text")} title="Most of its words come from the passage">
                      copied
                    </span>
                  ) : null}
                  {it.question !== it.original ? <span className={cn(TAG, "bg-accent-wash text-fg")}>edited</span> : null}
                  {it.dropped ? <span className={cn(TAG, "bg-removed text-removed-text")}>dropped</span> : null}
                </span>
              </div>
              <p className={cn("border-l-2 border-hairline pl-2 font-serif text-sm break-words text-fg-muted md:ml-8", it.dropped && "line-through")}>
                <span className="font-sans text-xs">Answered by:</span> {it.gold_answers[0]}
              </p>
              <div className="flex flex-wrap items-center gap-2 md:ml-8">
                {isEditing ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        const text = editing.text.trim()
                        if (text) update(i, { question: text })
                        setEditing(null)
                      }}
                    >
                      Done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        update(i, { question: it.original })
                        setEditing(null)
                      }}
                    >
                      Put back the original
                    </Button>
                  </>
                ) : it.dropped ? (
                  <Button size="sm" variant="outline" onClick={() => update(i, { dropped: false })}>
                    Keep after all
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setEditing({ i, text: it.question })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => update(i, { dropped: true })}>
                      Drop
                    </Button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {written.dropped.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">{plural(written.dropped.length, "question")} dropped by the checks</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {written.dropped.map((d, i) => (
              <li key={i} className="text-fg">
                {d.question ? <>"{d.question}" </> : null}
                {d.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
