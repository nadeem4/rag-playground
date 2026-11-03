import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react"

import { ApiError, api } from "@/api/client"
import { useSamples } from "@/api/samples"
import type { ProjectPreview, ServePreview, ServeWhere } from "@/api/types"
import { useAppSettings } from "@/api/useDemo"
import { useQuestionSetAcross } from "@/api/useQuestionSetAcross"
import { v2 } from "@/api/v2"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PipelineConfig, WorkingPipeline } from "@/state/config"
import { chooseDocument } from "@/state/document"
import { readPreviousEvaluation } from "@/state/evaluate"
import { usePipelines } from "@/state/pipelines"
import { useSorting } from "@/state/sorting"
import { categoryRows, defaultWhere, exportBody, READY_AT, summary, unnamedCount, type Row, type RowStatus } from "@/state/takeHome"
import { parseWorking, storedWorkingJson, subscribeWorking } from "@/state/working"

import "@/components/learn/learn.css"

/**
 * Take it home: check each category's questions, choose where the pipeline
 * will run, then download either the laptop project or the serve project for a
 * team. The server writes every file, so the preview is exactly the zip.
 * Nothing is stored on the server: the request carries everything.
 */

type Kind = "laptop" | "team"
type Preview = { key: string; files: Record<string, string>; filename: string; keys: { variable: string; optional: boolean; note?: string }[]; leftOut: string[] }

const FAILED = "The project could not be made just now. Try again."
const STATUS_WORD: Record<RowStatus, string> = { ready: "Ready", weak: "Weak check", "sample-only": "Sample questions only", "not-tested": "Not tested" }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The sentence a refused request carries, or the plain fallback. A server error never shows its raw text. */
function sayError(err: unknown): string {
  if (err instanceof ApiError && err.status < 500 && typeof err.detail === "string" && err.detail) return err.detail
  return FAILED
}

const goTo = (href: string) => window.location.assign(href)

export function TakeHomePage({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const json = useSyncExternalStore(subscribeWorking, storedWorkingJson)
  const working = useMemo(() => parseWorking(json), [json])
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page flex flex-col gap-6 pb-8">
        <section className="learn-top flex max-w-[680px] flex-col gap-2">
          <h1 className="learn-display">Take it home</h1>
          <p className="learn-lead">Check the questions your pipeline is tested on, then download it as a project you run yourself.</p>
        </section>
        {working ? (
          <Body working={working} navigate={navigate} />
        ) : (
          <p>
            There is no pipeline to take home yet.{" "}
            <a href="/build" className="font-semibold text-primary underline underline-offset-4">
              Build a pipeline
            </a>{" "}
            first.
          </p>
        )}
      </div>
      <SiteFooter />
    </main>
  )
}

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
  const { samples } = useSamples()
  const across = useQuestionSetAcross(docs.map((d) => d.sha), samples)
  const loaded = across.questions !== null
  const asked = across.questions ?? []
  const scoreFor = (key: string): string | null => {
    for (const k of new Set([pipelineKey ?? "working", "working"])) {
      const p = readPreviousEvaluation(key, k)
      if (p) return `${p.totals.found} of ${p.totals.total} found`
    }
    return null
  }
  const rows = categoryRows(config, docs, sorted, asked, { fromSamples: across.fromSamples, scoreFor })
  const totals = summary(rows)
  const unnamed = unnamedCount(asked)

  const [kind, setKind] = useState<Kind>("team")
  const [where, setWhere] = useState<ServeWhere>(defaultWhere)
  const [shown, setShown] = useState("README.md")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id
  const request = useMemo(
    () => (kind === "team" ? { kind, body: exportBody(config, name, rows, where) } : { kind, body: { config, name, scores: "" } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rows` is made from the values keyed below
    [kind, JSON.stringify([config, name, rows.map((r) => [r.id, r.sample, r.questions]), where])],
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
            leftOut: [
              ...p.left_out.categories.map((c) => `${nameOf(c.id)}: ${c.reason}`),
              ...rows.filter((r) => !r.documents.length).map((r) => `${r.name}: no document`),
              ...(unnamed ? [`${plural(unnamed, "question")} name no document`] : []),
              ...(p.left_out.documents ? ["Your documents: put your own copies in the documents folder where it runs"] : []),
              ...(p.left_out.lock ? ["uv.lock: run uv lock once and commit it"] : []),
            ],
          }),
        (err: unknown) => live && setError(sayError(err)),
      )
    } else {
      api.projectPreview(request.body).then(
        (p: ProjectPreview) =>
          done({
            key,
            files: p.files,
            filename: p.filename,
            keys: p.keys,
            leftOut: ["Your documents: put your own copies in docs/", "Saved index: run.py builds a fresh one the first time it runs"],
          }),
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
  const current_ = files.includes(shown) ? shown : "README.md"

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
  const field = "h-control w-full rounded-control border border-hairline bg-surface px-2 text-sm text-fg"

  return (
    <>
      <section aria-labelledby="th-check" className="flex flex-col gap-3">
        <h2 id="th-check" className="m-0 text-lg font-semibold">
          1. Check your questions
        </h2>
        <p className="m-0 text-fg-muted">
          {totals.ready} of {rows.length} {rows.length === 1 ? "category is" : "categories are"} ready ({READY_AT} or more questions of your own).{" "}
          {demo && cap !== undefined
            ? `${totals.questions} of ${cap} questions go in the download.`
            : `${plural(totals.questions, "question")} go in the project.`}
        </p>
        {demo ? <p className="m-0 text-fg-muted">Your questions and scores live only in this browser tab. They are gone when you close it, so download before you leave.</p> : null}
        {unnamed ? <p className="m-0 text-fg-muted">{plural(unnamed, "question")} name no document, so they are not in the project.</p> : null}
        <ul className="m-0 list-none border-t border-hairline p-0">
          {rows.map((r) => (
            <li key={r.id} data-testid={`row-${r.id}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hairline px-1 py-3">
              <h3 className="m-0 min-w-[8rem] text-base font-semibold">{r.name}</h3>
              <span className={cn("rounded-control px-2 text-xs font-semibold", r.status === "ready" ? "bg-accent-wash text-primary" : "bg-stale-wash text-stale")}>{STATUS_WORD[r.status]}</span>
              {r.status !== "not-tested" ? <span className="text-sm">{plural(r.count, "question")}</span> : null}
              <span className="min-w-0 text-sm break-words text-fg-muted">{r.documents.length ? r.documents.join(", ") : "No document"}</span>
              {r.lastScore ? <span className="text-sm text-fg-muted">Last score: {r.lastScore}</span> : null}
              <span className="ml-auto">
                <RowAction row={r} onWrite={() => void openEvaluate(r)} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="th-where" className="flex flex-col gap-3">
        <h2 id="th-where" className="m-0 text-lg font-semibold">
          2. Where it will run
        </h2>
        <div role="radiogroup" aria-label="Where it will run" className="flex flex-wrap gap-4">
          {(
            [
              ["laptop", "Try it on my laptop", "A small Python project that runs the pipeline on your own computer."],
              ["team", "Serve it for a team", "A project with a server, a Dockerfile and a quality check for each category."],
            ] as const
          ).map(([k, label, note]) => (
            <label key={k} className="flex max-w-[22rem] cursor-pointer items-start gap-3 text-sm">
              <input type="radio" name={kindId} className="mt-1 size-[14px] shrink-0 [accent-color:var(--text-primary)]" checked={kind === k} onChange={() => setKind(k)} aria-label={label} />
              <span>
                <strong>{label}</strong>
                <span className="block text-fg-muted">{note}</span>
              </span>
            </label>
          ))}
        </div>
        {kind === "laptop" ? (
          <p className="m-0 text-fg-muted">The where-it-runs settings are not used for the laptop project. It asks one example question and indexes the documents you put in docs/.</p>
        ) : (
          <div className="flex max-w-[34rem] flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={sourceId} className="text-sm font-semibold">
                Documents folder
              </label>
              <input id={sourceId} className={field} value={where.source} onChange={(e) => setWhere({ ...where, source: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={storeId} className="text-sm font-semibold">
                Index store
              </label>
              <select
                id={storeId}
                className={field}
                value={where.index_store}
                onChange={(e) => {
                  const store = e.target.value as ServeWhere["index_store"]
                  setWhere({ ...where, index_store: store, index_url: store === "lancedb" ? "./index" : "http://localhost:6333" })
                }}
              >
                <option value="lancedb">LanceDB, a folder next to the server</option>
                <option value="qdrant">Qdrant, a server of its own</option>
              </select>
            </div>
            {where.index_store === "qdrant" ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={urlId} className="text-sm font-semibold">
                  Index URL
                </label>
                <input id={urlId} className={field} value={where.index_url} onChange={(e) => setWhere({ ...where, index_url: e.target.value })} />
              </div>
            ) : (
              <p className="m-0 text-sm text-fg-muted">The index is kept in ./index next to the server.</p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="th-download" className="flex flex-col gap-3">
        <h2 id="th-download" className="m-0 text-lg font-semibold">
          3. Download
        </h2>
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
          <>
            <div data-testid="take-home-columns" className="flex flex-wrap gap-4">
              <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">In the zip</h3>
                <ul className="m-0 list-none border-t border-hairline p-0">
                  {files.map((f) => (
                    <li key={f} className="border-b border-hairline">
                      <button
                        type="button"
                        aria-pressed={f === current_}
                        onClick={() => setShown(f)}
                        className="w-full px-2 py-2 text-left font-mono text-xs hover:bg-surface-elevated aria-pressed:bg-accent-wash"
                      >
                        {f}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex min-w-0 flex-[2_1_20rem] flex-col gap-2">
                <h3 className="m-0 font-mono text-xs font-semibold">{current_}</h3>
                <div tabIndex={0} role="region" aria-label={`${current_} preview`} className="max-h-[340px] overflow-auto rounded-control border border-hairline bg-surface">
                  <pre data-testid="take-home-preview" className="m-0 px-3 py-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {ready.files[current_] ?? ""}
                  </pre>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">Left out</h3>
                <ul data-testid="take-home-left-out" className="m-0 list-none border-t border-hairline p-0">
                  {ready.leftOut.map((x) => (
                    <li key={x} className="border-b border-hairline px-2 py-2 text-sm text-fg-muted">
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">Keys</h3>
                <p className="m-0 text-sm text-fg-muted">Keys are never asked for here and never written to a file. Set these variables where the project runs.</p>
                <ul className="m-0 list-none border-t border-hairline p-0">
                  {ready.keys.length === 0 ? <li className="border-b border-hairline px-2 py-2 text-sm text-fg-muted">This pipeline needs no key.</li> : null}
                  {ready.keys.map((k) => (
                    <li key={k.variable} className="border-b border-hairline px-2 py-2 text-sm">
                      <code className="font-mono text-xs">{k.variable}</code>
                      <span className="text-fg-muted">
                        {k.optional ? " (optional)" : ""}
                        {k.note ? ` ${k.note}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!ready || busy} onClick={() => void download()}>
            Download {ready?.filename ?? "the project"}
          </Button>
        </div>
        <p className="m-0 text-fg-muted">
          {kind === "team"
            ? "Next: unzip it, run uv lock once and commit uv.lock, then follow the README to build the image and set the keys."
            : "Next: unzip it, put your documents in docs/, then follow the README."}
        </p>
        {done ? (
          <p role="status" className="m-0 rounded-control bg-accent-wash px-3 py-2 text-sm">
            Downloaded <span className="font-mono text-xs">{done}</span>.
          </p>
        ) : null}
      </section>
    </>
  )
}

const rank = (path: string) => (path === "README.md" ? 0 : path === "pipeline.yaml" ? 1 : 2)

function RowAction({ row, onWrite }: { row: Row; onWrite: () => void }) {
  const link = "text-sm font-semibold text-primary underline underline-offset-4"
  if (row.status === "weak")
    return (
      <Button size="sm" variant="outline" onClick={onWrite}>
        Write questions
      </Button>
    )
  if (row.status === "sample-only")
    return (
      <a href="/build" className={link}>
        Add a document of your own
      </a>
    )
  if (row.status === "not-tested")
    return (
      <a href="/build" className={link}>
        Test one on Build
      </a>
    )
  return null
}
