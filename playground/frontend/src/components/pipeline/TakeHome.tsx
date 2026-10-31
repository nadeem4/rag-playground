import { useEffect, useMemo, useState, type ReactNode } from "react"

import { PROVIDER_INFO } from "@/api/apiKey"
import { ApiError, api } from "@/api/client"
import { useSampleQuestions, useSamples } from "@/api/samples"
import type { ProjectPreview, ProjectRequest, Registry } from "@/api/types"
import { useQuestionSet } from "@/api/useQuestionSet"
import { SideSheet } from "@/components/SideSheet"
import { Button } from "@/components/ui/button"
import { graphToConfig, sameConfig, type PipelineConfig } from "@/state/config"
import { documentsOf, type DocRef } from "@/state/document"
import { questionsKey, readPreviousEvaluation } from "@/state/evaluate"
import { questionsFromSample, questionsFromSet, sampleFor } from "@/state/goldSet"
import type { PipelineGraph } from "@/state/graph"
import { evaluateTopK } from "@/state/pandionDefaults"

/** What each file in the project is for, in the order the list shows them. */
const FILE_NOTE: Record<string, string> = {
  "README.md": "What to do first, and what this pipeline does.",
  "pipeline.yaml": "The pipeline, step by step, with your settings.",
  "run.py": "Indexes docs/, then asks your questions.",
  "questions.json": "Your question set.",
  "requirements.txt": "What pip installs.",
  "docs/.gitkeep": "Empty. Put your documents here.",
}
const ORDER = Object.keys(FILE_NOTE)
const DOCS = "docs/.gitkeep"
const DOCS_PREVIEW = "(empty folder)\n\nPut your documents here."
const FAILED = "The project could not be made just now. Try again."

/** The sentence a refused request carries, or the plain fallback. A server error never shows its raw text. */
function sayError(err: unknown): string {
  if (err instanceof ApiError && err.status < 500 && typeof err.detail === "string" && err.detail) return err.detail
  return FAILED
}

/** A file's name as the list shows it: the empty docs folder as `docs/`. */
const shownName = (path: string) => (path === DOCS ? "docs/" : path)

/**
 * Take it home: Build's pipeline as a small Python project, as a zip. The
 * button opens a side sheet: the files in the
 * zip, each with the server's own text; what stays behind (the documents, the
 * key, the index); the question set and the scores to beat, when Evaluate has
 * them for this pipeline; and the settings the demo capped. The server writes
 * every file (`POST /api/project.zip`), so the preview is exactly the zip.
 */
export function TakeHome({ graph, name, pipelineKey, registry }: { graph: PipelineGraph; name: string; pipelineKey: string | null; registry: Registry }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Take it home
      </Button>
      {open ? <TakeHomeSheet graph={graph} name={name} pipelineKey={pipelineKey} topK={evaluateTopK(registry)} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** The question set Evaluate uses for this one document: an uploaded set first, else the sample's own. */
function useHomeQuestions(doc: DocRef | null): { set: unknown; count: number; key: string; from: string } | null {
  const uploaded = useQuestionSet(doc?.sha ?? "")
  const { samples } = useSamples()
  const sample = doc ? sampleFor(doc.sha, samples) : undefined
  const sampleQuestions = useSampleQuestions(uploaded.set || uploaded.loading ? undefined : sample?.name)
  if (!doc || uploaded.loading) return null
  if (uploaded.set) {
    const questions = uploaded.set.set.questions
    return { set: uploaded.set.set, count: questions.length, key: questionsKey(questionsFromSet(uploaded.set)), from: `From "${uploaded.set.filename}".` }
  }
  if (!sample || !sampleQuestions.length) return null
  const questions = questionsFromSample(sampleQuestions).map((q) => ({ ...q, document: doc.filename }))
  return {
    set: { version: 1, document: doc.filename, questions },
    count: questions.length,
    key: questionsKey(questions),
    from: "From the sample's own question set.",
  }
}

/**
 * The Evaluate result for this exact pipeline and question set, as one line,
 * or null. It must be scored at the top k run.py uses (`topK`, `pandion.evaluate`'s
 * default), with the same pipeline config and the same questions (id, text and
 * gold passages).
 */
function scoresToBeat(
  doc: DocRef | null,
  config: PipelineConfig | null,
  pipelineKey: string | null,
  questions: { key: string } | null,
  topK: number | null,
): string | null {
  if (!doc || !config || !questions || topK === null) return null
  for (const key of new Set([pipelineKey ?? "working", "working"])) {
    const p = readPreviousEvaluation(doc.sha, key)
    if (!p || p.k !== topK || !p.config || p.questions !== questions.key) continue
    if (!sameConfig(p.config as unknown as PipelineConfig, config)) continue
    const mrr = p.totals.mrr === null ? "" : `, MRR ${p.totals.mrr.toFixed(2)}`
    return `${p.totals.found} of ${p.totals.total} found${mrr}`
  }
  return null
}

function TakeHomeSheet({
  graph,
  name,
  pipelineKey,
  topK,
  onClose,
}: {
  graph: PipelineGraph
  name: string
  pipelineKey: string | null
  /** How many pieces run.py checks: `pandion.evaluate`'s default, from the catalog. */
  topK: number | null
  onClose: () => void
}) {
  const made = graphToConfig(graph)
  const documents = documentsOf(graph)
  // Evaluate scores one document's questions, so only a pipeline on one document takes a set home.
  const doc = documents.length === 1 ? documents[0] : null
  const questions = useHomeQuestions(doc)
  const config = made.ok ? made.pipeline.config : null
  const scores = scoresToBeat(doc, config, pipelineKey, questions, topK)
  const [withQuestions, setWithQuestions] = useState(true)
  const [withScores, setWithScores] = useState(true)
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState("README.md")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  // The server says how many questions a project may hold (the demo's cap); over it the set stays out.
  // A 413 for the questions also means over the cap, even when it does not say the number.
  const [maxQuestions, setMaxQuestions] = useState<number | null>(null)
  const [refused, setRefused] = useState(false)
  const overCap = questions !== null && (refused || (maxQuestions !== null && questions.count > maxQuestions))
  const bodyJson = JSON.stringify({
    config,
    name,
    ...(questions && withQuestions && !overCap ? { questions: questions.set } : {}),
    scores: scores && withScores ? scores : "",
  })
  const body = useMemo(() => JSON.parse(bodyJson) as ProjectRequest, [bodyJson])

  useEffect(() => {
    if (!made.ok) return
    let live = true
    setError(null)
    api.projectPreview(body).then(
      (p) => {
        // The cap holds for every request, so it is kept even from an answer that came too late to show.
        if (p.max_questions !== null) setMaxQuestions(p.max_questions)
        if (live) setPreview(p)
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 413 && body.questions !== undefined) {
          // Over the cap: the box unticks itself and the body changes, so the preview runs again without the set.
          const most = typeof err.detail === "string" ? /at most (\d+) questions/.exec(err.detail)?.[1] : undefined
          if (most) setMaxQuestions(Number(most))
          else setRefused(true)
          return
        }
        if (live) setError(sayError(err))
      },
    )
    return () => {
      live = false
    }
  }, [body, made.ok])

  async function download() {
    if (!preview) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const zip = await api.projectZip(body)
      const url = URL.createObjectURL(zip)
      const a = document.createElement("a")
      a.href = url
      a.download = preview.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDone(preview.filename)
    } catch (err) {
      setError(sayError(err))
    } finally {
      setBusy(false)
    }
  }

  const files = preview ? [...ORDER.filter((f) => f in preview.files), ...Object.keys(preview.files).filter((f) => !ORDER.includes(f))] : []
  const current = files.includes(shown) ? shown : "README.md"
  const text = current === DOCS ? DOCS_PREVIEW : (preview?.files[current] ?? "")
  const filename = preview?.filename ?? "project.zip"
  const limited = preview?.limited ?? []

  return (
    <SideSheet
      title="Take this pipeline home"
      medium
      onClose={onClose}
      head={<p className="text-sm text-fg-muted">A small Python project that runs this pipeline on your own computer, with the same settings you used here.</p>}
      footer={
        <>
          <span className="text-sm text-fg-muted">Needs Python 3.13</span>
          <span className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!preview || busy} onClick={() => void download()}>
              Download {filename}
            </Button>
          </span>
        </>
      }
    >
      {!made.ok ? (
        <p role="alert" className="text-sm text-danger">
          {made.problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-4">
        <section aria-labelledby="take-home-in" className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2">
          <h3 id="take-home-in" className="text-sm font-semibold text-fg">
            In the zip
          </h3>
          {preview ? (
            <ul className="border-t border-hairline">
              {files.map((f) => (
                <li key={f} className="border-b border-hairline">
                  <button
                    type="button"
                    aria-pressed={f === current}
                    onClick={() => setShown(f)}
                    className="flex w-full items-baseline gap-3 px-2 py-2 text-left hover:bg-surface-elevated aria-pressed:bg-accent-wash"
                  >
                    <span className="font-mono text-xs whitespace-nowrap text-fg">{shownName(f)}</span>
                    <span className="text-xs text-fg-muted">{FILE_NOTE[f] ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : error ? null : (
            <p role="status" className="text-sm text-fg-muted">
              Getting the files ready
            </p>
          )}
        </section>
        <section aria-labelledby="take-home-out" className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2">
          <h3 id="take-home-out" className="text-sm font-semibold text-fg">
            Not in the zip
          </h3>
          <ul className="border-t border-hairline">
            {documents.map((d) => (
              <OutRow key={d.sha} what={d.filename}>
                Your documents stay here. Put your own copies in <code className="font-mono">docs/</code>.
              </OutRow>
            ))}
            {preview && preview.keys.length === 0 ? (
              <li className="border-b border-hairline px-2 py-2 text-xs text-fg-muted">This pipeline needs no key.</li>
            ) : null}
            {preview?.keys.map((k) => {
              const provider = Object.values(PROVIDER_INFO).find((p) => p.env === k.variable)
              return (
                <OutRow key={k.variable} what={`${provider?.name ?? "API"} key`}>
                  Keys are never written to a file, so the zip only names the variable to set. Set{" "}
                  <code className="font-mono">{k.variable}</code> on your computer
                  {k.optional ? " only if your server asks for a key." : "."}
                </OutRow>
              )
            })}
            <OutRow what="Saved index">run.py builds a fresh one the first time it runs.</OutRow>
          </ul>
        </section>
      </div>

      {questions || scores ? (
        <section aria-labelledby="take-home-include" className="flex flex-col gap-3">
          <h3 id="take-home-include" className="text-sm font-semibold text-fg">
            Include
          </h3>
          {questions ? (
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-[14px] shrink-0 [accent-color:var(--text-primary)]"
                checked={withQuestions && !overCap}
                disabled={overCap}
                onChange={(e) => setWithQuestions(e.target.checked)}
              />
              <span>
                <strong>Your {questions.count} questions</strong>
                <span className="block text-fg-muted">
                  {overCap
                    ? maxQuestions !== null
                      ? `The demo packs at most ${maxQuestions} questions.`
                      : "The demo packs fewer questions than this set has."
                    : `${questions.from} run.py checks each one and prints how many it found.`}
                </span>
              </span>
            </label>
          ) : null}
          {scores ? (
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 size-[14px] shrink-0 [accent-color:var(--text-primary)]" checked={withScores} onChange={(e) => setWithScores(e.target.checked)} />
              <span>
                <strong>Scores to beat</strong>
                <span className="block text-fg-muted">Adds your Evaluate result to the README: {scores}.</span>
              </span>
            </label>
          ) : null}
        </section>
      ) : null}

      {preview ? (
        <section aria-labelledby="take-home-shown" className="flex flex-col gap-2">
          <h3 id="take-home-shown" className="font-mono text-xs font-semibold text-fg">
            {shownName(current)}
          </h3>
          <div tabIndex={0} role="region" aria-labelledby="take-home-shown" className="max-h-[340px] overflow-auto rounded-control border border-hairline bg-surface">
            <pre data-testid="take-home-preview" className="m-0 px-3 py-3 font-mono text-xs leading-relaxed whitespace-pre">
              {text}
            </pre>
          </div>
        </section>
      ) : null}

      {limited.length ? (
        <div className="rounded-control bg-surface-elevated px-3 py-2 text-sm">
          <p>
            <strong>Settings at the demo's cap.</strong> The hosted demo caps some settings. The project uses them as you set them here, and the
            README lists {limited.length === 1 ? "the one that was" : `the ${limited.length} that were`} capped:{" "}
            {limited.map((x, i) => (
              <span key={x.setting}>
                {i ? ", " : ""}
                <code className="font-mono text-xs">{x.setting}</code> ({x.cap})
              </span>
            ))}
            . Raise them on your own computer if you like.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-control bg-accent-wash px-3 py-2 text-sm">
          Downloaded <span className="font-mono text-xs">{done}</span>. Unzip it, then follow the README.
        </p>
      ) : null}
    </SideSheet>
  )
}

function OutRow({ what, children }: { what: string; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3 border-b border-hairline px-2 py-2">
      <span className="font-mono text-xs whitespace-nowrap text-fg-muted line-through">{what}</span>
      <span className="text-xs text-fg-muted">{children}</span>
    </li>
  )
}
