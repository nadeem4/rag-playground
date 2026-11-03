import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"

import { ApiError, api } from "@/api/client"
import { useSamples } from "@/api/samples"
import type { ProjectPreview, SampleCard, ServePreview, ServeWhere } from "@/api/types"
import { useAppSettings } from "@/api/useDemo"
import { useTakeHomeQuestions } from "@/api/useTakeHomeQuestions"
import { v2 } from "@/api/v2"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PipelineConfig, WorkingPipeline } from "@/state/config"
import { chooseDocument } from "@/state/document"
import { readPreviousEvaluation } from "@/state/evaluate"
import { STARTER_ID, usePipelines } from "@/state/pipelines"
import { useSorting } from "@/state/sorting"
import { categoryRows, defaultWhere, exportBody, laptopQuestions, summary, unnamedCount, type Row } from "@/state/takeHome"
import { parseWorking, storedWorkingJson, subscribeWorking } from "@/state/working"

import "@/components/learn/learn.css"

/**
 * Take it home: check each category's questions, say where the pipeline will
 * run, then download either the laptop project or the serve project for a
 * team. The server writes every file, so the preview is exactly the zip.
 * Nothing is stored on the server: the request carries everything.
 */

type Kind = "laptop" | "team"
type Key = { variable: string; optional: boolean; note?: string }
type Preview = { key: string; files: Record<string, string>; filename: string; keys: Key[]; left: { name: string; why: string }[] }

const FAILED = "The project could not be made just now. Try again."
const STATUS_WORD = { ready: "Ready", weak: "Weak check", "sample-only": "Sample questions only", "not-tested": "Not tested" } as const
const REASON: Record<string, string> = { "sample questions only": "Only sample questions.", "no questions": "No questions yet." }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The sentence a refused request carries, or the plain fallback. A server error never shows its raw text. */
function sayError(err: unknown): string {
  if (err instanceof ApiError && err.status < 500 && typeof err.detail === "string" && err.detail) return err.detail
  return FAILED
}

/** What each file is for, in a few words. */
const TEAM_NOTE: Record<string, string> = {
  "pipeline.yaml": "Your pipeline, categories and where it runs.",
  "serve.py": "Starts the chat API.",
  "policy.py": "Who the user is, their roles and limits.",
  "tests/test_quality.py": "The quality check: run it before each deploy.",
  Dockerfile: "Builds the server image.",
  "pyproject.toml": "Pandion and pandion-api from PyPI.",
  ".env.example": "Every secret, with a note on each.",
  ".dockerignore": "Keeps secrets and data out of the image.",
  ".gitignore": "Keeps secrets and data out of git.",
  "README.md": "Run, sync, deploy, check quality, stay safe.",
}
const LAPTOP_NOTE: Record<string, string> = {
  "pipeline.yaml": "Your pipeline and categories.",
  "run.py": "Runs your pipeline and your questions.",
  "questions.json": "Your questions on your own documents.",
  "requirements.txt": "Pandion from PyPI.",
  "docs/.gitkeep": "Empty. Put your documents here.",
  "README.md": "How to run it.",
}
const ORDER = ["pipeline.yaml", "run.py", "serve.py", "policy.py", "evals/", "questions.json", "tests/", "Dockerfile", "pyproject.toml", "requirements.txt", ".env.example", ".dockerignore", ".gitignore", "docs/", "README.md"]
const rank = (path: string) => {
  const at = ORDER.findIndex((o) => path === o || (o.endsWith("/") && path.startsWith(o)))
  return at === -1 ? ORDER.length : at
}

function fileNote(kind: Kind, path: string, text: string): string {
  if (path.startsWith("evals/")) {
    try {
      const n = (JSON.parse(text) as { questions?: unknown[] }).questions?.length
      if (n) return `${plural(n, "question")}, tagged by category.`
    } catch {
      // Not JSON we can count: the plain line below.
    }
    return "Your questions, tagged by category."
  }
  return (kind === "team" ? TEAM_NOTE : LAPTOP_NOTE)[path] ?? ""
}

const goTo = (href: string) => window.location.assign(href)

export function TakeHomePage({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const json = useSyncExternalStore(subscribeWorking, storedWorkingJson)
  const working = useMemo(() => parseWorking(json), [json])
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page flex flex-col gap-8 pb-8">
        {working ? (
          <Body working={working} navigate={navigate} />
        ) : (
          <section className="learn-top flex max-w-[680px] flex-col gap-2">
            <h1 className="learn-display">Take it home</h1>
            <p>
              There is no pipeline to take home yet.{" "}
              <a href="/build" className="font-semibold text-primary underline underline-offset-4">
                Build a pipeline
              </a>{" "}
              first.
            </p>
          </section>
        )}
      </div>
      <SiteFooter />
    </main>
  )
}

const NO_SAMPLES: SampleCard[] = []

const numbered = (n: number, title: string): ReactNode => (
  <>
    <span className="font-mono text-fg-muted">{n}</span> {title}
  </>
)

function Body({ working, navigate }: { working: WorkingPipeline; navigate: (href: string) => void }) {
  const config: PipelineConfig = working.config
  const docs = working.documents
  const { pipelines, currentId } = usePipelines()
  const current = pipelines.find((p) => p.id === currentId)
  const name = current?.name ?? ""
  const pipelineKey = current ? currentId : null
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const cap = settings?.limits?.max_evaluation_questions

  const sorted = useSorting(config, docs)
  // A sample list that cannot be read means no samples, not waiting for them.
  const { samples: listed, error: samplesError } = useSamples()
  const samples = samplesError ? NO_SAMPLES : listed
  const { questions, sampleShas } = useTakeHomeQuestions(docs, samples)
  const loaded = questions !== null
  const asked = questions ?? []
  // Evaluate keeps the last result under all the pipeline's documents, so there is one score for the whole.
  const docsKey = docs.map((d) => d.sha).join(",")
  const reference = (() => {
    for (const k of new Set([pipelineKey ?? "working", ...(currentId === STARTER_ID ? [STARTER_ID] : []), "working"])) {
      const p = readPreviousEvaluation(docsKey, k)
      if (p) return `found ${p.totals.found} of ${p.totals.total}`
    }
    return null
  })()
  const rows = categoryRows(config, docs, sorted, asked, { sampleShas })
  const totals = summary(rows)
  const unnamed = unnamedCount(asked)

  const [kind, setKind] = useState<Kind>("team")
  const [where, setWhere] = useState<ServeWhere>(defaultWhere)
  const [shown, setShown] = useState("pipeline.yaml")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id
  const request = useMemo(
    () => (kind === "team" ? { kind, body: exportBody(config, name, rows, where) } : { kind, body: { config, name, questions: laptopQuestions(rows), scores: "" } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rows` is made from the values keyed below
    [kind, JSON.stringify([config, name, rows.map((r) => [r.id, r.sample, r.documents, r.questions]), where])],
  )
  const key = JSON.stringify(request)

  useEffect(() => {
    if (!loaded) return
    let live = true
    setError(null)
    const done = (p: Preview) => live && setPreview(p)
    if (request.kind === "team") {
      v2.serveProjectPreview(request.body).then(
        (p: ServePreview) =>
          done({
            key,
            files: p.files,
            filename: p.filename,
            keys: p.keys,
            left: [
              ...p.left_out.categories.map((c) => ({ name: nameOf(c.id), why: REASON[c.reason] ?? c.reason })),
              ...rows.filter((r) => !r.documents.length).map((r) => ({ name: r.name, why: "No document." })),
              ...(p.left_out.documents ? [{ name: "docs/", why: "Your documents stay with you." }] : []),
              ...(p.left_out.lock ? [{ name: "uv.lock", why: "You make it with one command, see README." }] : []),
            ],
          }),
        (err: unknown) => live && setError(sayError(err)),
      )
    } else {
      api.projectPreview(request.body).then(
        (p: ProjectPreview) => done({ key, files: p.files, filename: p.filename, keys: p.keys, left: [] }),
        (err: unknown) => live && setError(sayError(err)),
      )
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the whole request
  }, [key, loaded])

  const ready = preview?.key === key ? preview : null
  const files = ready ? Object.keys(ready.files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)) : []
  const current_ = files.includes(shown) ? shown : (files[0] ?? "")

  async function download() {
    if (!ready) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const zip = request.kind === "team" ? await v2.serveProjectZip(request.body) : await api.projectZip(request.body)
      const url = URL.createObjectURL(zip)
      const a = document.createElement("a")
      a.href = url
      a.download = ready.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDone(ready.filename)
    } catch (err) {
      setError(sayError(err))
    } finally {
      setBusy(false)
    }
  }

  async function openEvaluate(row: Row) {
    const doc = docs.find((d) => d.sha === row.shas[0])
    if (doc) await chooseDocument(doc)
    navigate("/evaluate")
  }

  const kindId = useId()
  const storeId = useId()
  const urlId = useId()
  const sourceId = useId()
  const team = kind === "team"
  const field = "h-control w-full rounded-control border border-hairline bg-surface px-2 text-sm text-fg"
  const keys = ready?.keys ?? []

  return (
    <>
      <section className="learn-top flex max-w-[680px] flex-col gap-2">
        <a href="/build" className="text-sm font-semibold text-primary underline underline-offset-4">
          Back to Build
        </a>
        <h1 className="learn-display">Take it home</h1>
        <p className="learn-lead">
          Download your pipeline{name ? <> <span className="font-mono text-fg">{name}</span></> : null} as a project you can run. First check your questions, then say where it will run.
        </p>
      </section>

      {demo ? (
        <div role="note" className="flex max-w-[680px] flex-col gap-1 rounded-control border border-hairline bg-stale-wash p-4">
          <strong className="text-stale">You are on the hosted demo.</strong>
          <p className="m-0">Your questions and scores live only in this browser tab. Download before you close it, or they are gone.</p>
          {cap !== undefined ? (
            <p className="m-0">
              The demo keeps up to {cap} questions. You have used <span className="font-mono">{asked.length}</span> of <span className="font-mono">{cap}</span>.
            </p>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="th-check" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="th-check" className="m-0 text-lg font-semibold">
            {numbered(1, "Check your questions")}
          </h2>
          <p className="m-0">
            <strong>
              {totals.ready} of {rows.length} {rows.length === 1 ? "category is" : "categories are"} ready.
            </strong>{" "}
            <span className="font-mono">{totals.questions}</span> {totals.questions === 1 ? "question goes" : "questions go"} into the download. Each category needs its own questions, so the quality check can catch a problem in that kind of document.
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((r) => (
            <li key={r.id} data-testid={`row-${r.id}`} className="flex flex-wrap gap-x-6 gap-y-3 rounded-control border border-hairline bg-surface-elevated p-4">
              <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-2">
                <h3 className="m-0 text-base font-semibold">{r.name}</h3>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {(r.docs.length ? r.docs : [{ filename: "No document tested yet", tag: "Empty" as const }]).map((d) => (
                    <span key={d.filename} className="inline-flex items-center gap-2 text-xs">
                      <span className={cn("font-mono", r.docs.length ? "break-all" : "break-words")}>{d.filename}</span>
                      <span className="rounded-control bg-surface px-2 text-fg-muted">{d.tag}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex-[0_1_9rem] text-sm">
                <span className="font-mono">{r.count}</span> {r.count === 1 ? "question" : "questions"}
              </div>
              <div className="flex min-w-0 flex-[999_1_20rem] flex-col gap-2">
                <p className="m-0">
                  <strong className={cn(r.status === "ready" ? "text-primary" : "text-stale")}>
                    {r.mark} {STATUS_WORD[r.status]}.
                  </strong>{" "}
                  {r.text}
                </p>
                <RowAction row={r} onWrite={() => void openEvaluate(r)} />
              </div>
            </li>
          ))}
          {unnamed ? (
            <li data-testid="row-unnamed" className="rounded-control border border-dashed border-hairline px-4 py-3 text-fg-muted">
              <span className="font-mono">{unnamed}</span> {unnamed === 1 ? "question names" : "questions name"} no document, so {unnamed === 1 ? "it has" : "they have"} no category. {unnamed === 1 ? "It stays" : "They stay"} out of the download.
            </li>
          ) : null}
        </ul>
        {reference ? <p className="m-0 text-sm">Last run on Evaluate: {reference}.</p> : null}
        <p className="m-0 text-sm text-fg-muted">Scores come from your last run on Evaluate and are shown only for reference. The real starting score is recorded later, on your server, with the built project.</p>
      </section>

      <section aria-labelledby="th-where" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="th-where" className="m-0 text-lg font-semibold">
            {numbered(2, "Where it will run")}
          </h2>
          <p className="m-0">
            The playground keeps your documents and index on this machine. Tell us where they will live for your team. You can change these later in <span className="font-mono">pipeline.yaml</span>.
          </p>
        </div>
        {!team ? <p className="m-0 rounded-control bg-surface-elevated px-4 py-3">You chose the laptop project below. It keeps everything in local folders, so these settings are not used.</p> : null}
        <fieldset disabled={!team} className="m-0 flex flex-wrap gap-5 rounded-control border border-hairline bg-surface-elevated p-5">
          <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1">
            <label htmlFor={sourceId} className="font-semibold">
              Where your documents live
            </label>
            <input id={sourceId} className={cn(field, "font-mono")} value={where.source} onChange={(e) => setWhere({ ...where, source: e.target.value })} aria-describedby={`${sourceId}-help`} />
            <span id={`${sourceId}-help`} className="text-xs text-fg-muted">
              A folder, or a bucket such as <span className="font-mono">gs://</span>, <span className="font-mono">s3://</span> or Azure. Sync reads new and changed files from here.
            </span>
          </div>
          <div role="radiogroup" aria-labelledby={`${storeId}-legend`} className="flex min-w-0 flex-[1_1_18rem] flex-col gap-2">
            <span id={`${storeId}-legend`} className="font-semibold">
              Where the index lives
            </span>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["lancedb", "LanceDB", "./index"],
                  ["qdrant", "Qdrant", "http://localhost:6333"],
                ] as const
              ).map(([store, label, url]) => (
                <label key={store} className={cn("flex min-h-control cursor-pointer items-center gap-2 rounded-control border px-3 text-sm", where.index_store === store ? "border-primary bg-accent-wash" : "border-hairline bg-surface")}>
                  <input
                    type="radio"
                    name={storeId}
                    className="size-[14px] [accent-color:var(--text-primary)]"
                    checked={where.index_store === store}
                    onChange={() => setWhere({ ...where, index_store: store, index_url: url })}
                  />
                  {label}
                </label>
              ))}
            </div>
            {where.index_store === "qdrant" ? (
              <>
                <label htmlFor={urlId} className="text-sm">
                  Its address
                </label>
                <input id={urlId} className={cn(field, "font-mono")} value={where.index_url} onChange={(e) => setWhere({ ...where, index_url: e.target.value })} />
              </>
            ) : (
              <p className="m-0 text-xs text-fg-muted">LanceDB keeps the index in a folder, ./index, next to the server.</p>
            )}
          </div>
          {team ? (
            <div className="flex flex-[1_1_100%] flex-col gap-2 border-t border-hairline pt-4">
              <h3 className="m-0 text-base font-semibold">Secrets you set on your server</h3>
              <p className="m-0 text-fg-muted">
                This page never asks for them, and they are never in the download. <span className="font-mono">.env.example</span> lists them with a note on each.
              </p>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {ready && keys.length === 0 ? <li className="text-sm text-fg-muted">This pipeline needs no key.</li> : null}
                {keys.map((k) => (
                  <li key={k.variable} className="flex flex-wrap gap-x-3 gap-y-1">
                    <span className="font-mono font-semibold">{k.variable}</span>
                    <span className="text-fg-muted">
                      {k.note}
                      {k.optional ? " (optional)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="m-0">
                <strong>Who can read what:</strong> access control is off in this download. <span className="font-mono">pipeline.yaml</span> has a short example to turn it on with roles for each folder.
              </p>
            </div>
          ) : null}
        </fieldset>
      </section>

      <section aria-labelledby="th-download" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="th-download" className="m-0 text-lg font-semibold">
            {numbered(3, "Download")}
          </h2>
          <p className="m-0">Choose what you want to do with it.</p>
        </div>
        <div role="radiogroup" aria-label="What to download" className="flex flex-wrap gap-3">
          {(
            [
              ["laptop", "Try it on my laptop", "One script that runs your pipeline and your questions. Good for learning and quick checks."],
              ["team", "Serve it for a team", "A chat API with streaming, sync from your documents, a quality check and logs. Ready to put behind your gateway."],
            ] as const
          ).map(([k, label, note]) => (
            <label key={k} className={cn("flex min-w-0 flex-[1_1_18rem] cursor-pointer items-start gap-3 rounded-control border p-4 text-sm", kind === k ? "border-primary bg-accent-wash" : "border-hairline bg-surface-elevated")}>
              <input type="radio" name={kindId} className="mt-1 size-[14px] shrink-0 [accent-color:var(--text-primary)]" checked={kind === k} onChange={() => setKind(k)} aria-label={label} />
              <span className="flex flex-col gap-1">
                <strong>{label}</strong>
                <span className="text-fg-muted">{note}</span>
              </span>
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        ) : null}
        {!ready && !error ? (
          <p role="status" className="m-0 text-fg-muted">
            Getting the files ready
          </p>
        ) : null}
        {ready ? (
          <div data-testid="take-home-columns" className="flex flex-wrap gap-4 rounded-control border border-hairline bg-surface-elevated p-4">
            <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
              <h3 className="m-0 mb-1 text-base font-semibold">
                In the download (<span className="font-mono">{files.length}</span> files)
              </h3>
              {files.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={f === current_}
                  onClick={() => setShown(f)}
                  className="flex min-h-control w-full flex-col items-start gap-0.5 rounded-control border border-transparent px-3 py-2 text-left hover:bg-surface aria-pressed:border-primary aria-pressed:bg-accent-wash"
                >
                  <span className="font-mono text-sm font-semibold">{f}</span>
                  <span className="text-xs text-fg-muted">{fileNote(kind, f, ready.files[f] ?? "")}</span>
                </button>
              ))}
              {team && ready.left.length ? (
                <div className="mt-2 flex flex-col gap-1 border-t border-hairline pt-3">
                  <h4 className="m-0 text-sm font-semibold">Left out</h4>
                  <ul data-testid="take-home-left-out" className="m-0 flex list-none flex-col gap-1 p-0">
                    {ready.left.map((x) => (
                      <li key={x.name} className="text-xs text-fg-muted">
                        <span className="font-mono line-through">{x.name}</span> {x.why}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-[2_1_22rem] flex-col gap-2">
              <h3 className="m-0 text-base font-semibold">
                Preview: <span className="font-mono">{current_}</span>
              </h3>
              <div tabIndex={0} role="region" aria-label={`Preview of ${current_}`} className="max-h-[460px] overflow-auto rounded-control border border-hairline bg-surface">
                <pre data-testid="take-home-preview" className="m-0 px-4 py-4 font-mono text-xs leading-relaxed whitespace-pre">
                  {ready.files[current_] ?? ""}
                </pre>
              </div>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button disabled={!ready || busy} onClick={() => void download()}>
            Download {ready?.filename ?? "the project"}
          </Button>
          <span className="min-w-0 flex-[1_1_18rem] text-fg-muted">
            {team
              ? "Next, follow the README: build the image, run the first sync, then record your starting score with the built image."
              : "Next, open README.md and run python run.py."}
          </span>
        </div>
        {done ? (
          <p role="status" className="m-0 font-semibold text-primary">
            Downloaded <span className="font-mono">{done}</span>.
          </p>
        ) : null}
      </section>
    </>
  )
}

function RowAction({ row, onWrite }: { row: Row; onWrite: () => void }) {
  if (!row.action) return null
  if (row.action.kind === "write")
    return (
      <div>
        <Button size="sm" variant="outline" onClick={onWrite}>
          {row.action.label}
        </Button>
      </div>
    )
  return (
    <div>
      <a href="/build" className="text-sm font-semibold text-primary underline underline-offset-4">
        {row.action.label}
      </a>
    </div>
  )
}
