import { useRef, useState, type DragEvent } from "react"

import { api, ApiError } from "@/api/client"
import { useAppSettings } from "@/api/useDemo"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { refreshUploads, useDocument } from "@/state/document"
import { storeGraph } from "@/state/graph"
import {
  base64ToBytes,
  buildExport,
  bytesToBase64,
  docState,
  experimentSummary,
  exportFileName,
  importResultLine,
  isSoon,
  libraryItems,
  listWords,
  parseImport,
  pipelineSummary,
  savedWhen,
  uploadsOf,
  type DocState,
  type ExportedDocument,
  type LibraryItem,
} from "@/state/library"
import { deleteExperiment, importExperiments, openExperiment, useExperiments } from "@/state/libraryExperiments"
import { deletePipeline, importPipelines, setCurrentId, usableGraph, usePipelines } from "@/state/pipelines"

import "@/components/learn/learn.css"

/**
 * Library: every saved pipeline and experiment in one list, with what each
 * one's document is doing, and a way to carry them out of this browser and
 * back in as one file. Pipelines come from state/pipelines.ts, experiments
 * from Compare's store through state/libraryExperiments.ts.
 */

type Filter = "all" | "pipeline" | "experiment"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const hoursWords = (h: number) => (h <= 0 ? "under an hour" : plural(h, "hour"))
const size = (bytes: number) => (bytes < 0.1 * 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)

function navigate(path: string) {
  window.location.assign(path)
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function reason(err: unknown): string {
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail
  return "the server did not answer. Try again in a moment."
}

function DocLine({ item, state, demo }: { item: LibraryItem; state: DocState; demo: boolean }) {
  const f = item.doc?.filename || "The document"
  let dot = "bg-primary"
  let text: string
  switch (state.kind) {
    case "none":
      return <span className="text-sm text-fg-muted">No document</span>
    case "checking":
      text = f
      dot = "bg-flat"
      break
    case "sample":
      text = `${f}, a sample, always there`
      break
    case "local":
      text = `${f}, on this machine`
      break
    case "upload":
      if (state.hoursLeft === null) text = `${f}, an upload on the demo`
      else if (isSoon(state)) {
        text = `${f} is deleted from the demo in ${hoursWords(state.hoursLeft)}. Export with the document to keep it.`
        dot = "bg-stale"
      } else text = `${f}, on the demo for ${plural(state.hoursLeft, "more hour")}`
      break
    case "gone":
      text = `${f} is no longer on ${demo ? "the demo" : "this machine"}. Opening this asks you to upload it again.`
      dot = "bg-danger"
      break
  }
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2 text-sm text-fg-muted">
      <span aria-hidden className={cn("size-2 shrink-0 translate-y-[-1px] self-center rounded-full", dot)} />
      <span className="min-w-0 break-words">{text}</span>
    </span>
  )
}

export function Library({ go = navigate }: { go?: (path: string) => void } = {}) {
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const ttlHours = settings?.limits?.ttl_hours ?? 24
  const { samples, uploads } = useDocument()
  const { pipelines } = usePipelines()
  const experiments = useExperiments()
  const items = libraryItems(pipelines, experiments)
  const now = Date.now()
  const ctx = { demo, ttlHours, now, samples, sources: settings ? uploads : null }
  const states = new Map(items.map((i) => [i.id + i.kind, docState(i.doc, ctx)]))
  const stateOf = (i: LibraryItem) => states.get(i.id + i.kind) ?? { kind: "checking" as const }

  const [filter, setFilter] = useState<Filter>("all")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState<string[] | null>(null)
  const [withDoc, setWithDoc] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const key = (i: LibraryItem) => `${i.kind}:${i.id}`
  const shown = items.filter((i) => filter === "all" || i.kind === filter)
  const counts: Record<Filter, number> = {
    all: items.length,
    pipeline: items.filter((i) => i.kind === "pipeline").length,
    experiment: items.filter((i) => i.kind === "experiment").length,
  }
  const soon = items.filter((i) => isSoon(stateOf(i)))
  const soonHours = Math.min(...soon.map((i) => { const s = stateOf(i); return s.kind === "upload" && s.hoursLeft !== null ? s.hoursLeft : Infinity }))

  const startExport = (keys: string[], includeDoc = demo) => {
    setExporting(keys)
    setWithDoc(includeDoc)
    setNotice(null)
  }

  const chosen = exporting ? items.filter((i) => exporting.includes(key(i))) : []
  // Uploads the chosen items use that are on the server now, so their bytes can go in the file.
  const exportable = uploadsOf(chosen, samples).flatMap((d) => {
    const listed = uploads?.find((u) => u.sha === d.sha)
    return listed ? [{ ...d, size: listed.size }] : []
  })

  async function doExport() {
    setBusy(true)
    const documents: ExportedDocument[] = []
    const unread: string[] = []
    if (withDoc) {
      for (const d of exportable) {
        try {
          const res = await fetch(api.sourceFileUrl(d.sha))
          if (!res.ok) throw new Error(String(res.status))
          documents.push({ sha: d.sha, filename: d.filename, pdfBase64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) })
        } catch {
          unread.push(d.filename)
        }
      }
    }
    const name = exportFileName(chosen, Date.now())
    download(name, JSON.stringify(buildExport(chosen, documents, Date.now()), null, 2))
    const docWords = documents.length === 1 && chosen.length === 1 ? " and its document" : documents.length ? ` and ${plural(documents.length, "document")}` : ""
    const missed = unread.length ? ` ${listWords(unread)} could not be read, so ${unread.length === 1 ? "it is" : "they are"} not in the file.` : ""
    setNotice(`Exported ${plural(chosen.length, "item")}${docWords} to ${name}.${missed}`)
    setExporting(null)
    setPicked(new Set())
    setBusy(false)
  }

  async function open(item: LibraryItem) {
    if (item.kind === "experiment") {
      openExperiment(item.id)
      go("/compare")
      return
    }
    try {
      const graph = usableGraph(item.pipeline, await api.registry())
      if (!graph) {
        setNotice(`${item.name} uses steps this server does not have, so it cannot open here.`)
        return
      }
      setCurrentId(item.id)
      storeGraph(graph)
      go("/build")
    } catch {
      setNotice("The server did not answer, so the pipeline could not open. Try again in a moment.")
    }
  }

  function remove(item: LibraryItem) {
    if (item.kind === "pipeline") deletePipeline(item.id)
    else deleteExperiment(item.id)
    setPicked((p) => {
      const next = new Set(p)
      next.delete(key(item))
      return next
    })
  }

  async function importFile(file: File) {
    setExporting(null)
    setBusy(true)
    try {
      const parsed = parseImport(await file.text())
      if (!parsed.ok) {
        setNotice(parsed.error)
        return
      }
      const p = importPipelines(parsed.pipelines)
      const e = importExperiments(parsed.experiments)
      if (!p || !e) {
        setNotice("This browser would not save the items. Its storage may be full or blocked.")
        return
      }
      const restored: string[] = []
      const refused: { filename: string; reason: string }[] = []
      const damaged: string[] = []
      const mismatched: string[] = []
      for (const d of parsed.documents) {
        const there = samples?.some((s) => s.sha === d.sha) || uploads?.some((u) => u.sha === d.sha)
        if (there) continue
        let bytes: Uint8Array<ArrayBuffer>
        try {
          bytes = base64ToBytes(d.pdfBase64) as Uint8Array<ArrayBuffer>
        } catch {
          damaged.push(d.filename)
          continue
        }
        try {
          const stored = await api.uploadSource(new File([bytes], d.filename, { type: "application/pdf" }))
          // The server names a file by its bytes, so a different sha means different bytes.
          if (stored.sha === d.sha) restored.push(d.filename)
          else mismatched.push(d.filename)
        } catch (err) {
          refused.push({ filename: d.filename, reason: reason(err) })
        }
      }
      if (restored.length || mismatched.length) refreshUploads()
      setNotice(
        importResultLine({
          fileName: file.name,
          pipelines: p.added,
          experiments: e.added,
          already: p.skipped + e.skipped,
          leftOutPipelines: p.leftOut.map((x) => x.name),
          leftOutExperiments: e.leftOut.map((x) => x.name),
          unreadable: parsed.skipped + e.invalid,
          restored,
          refused,
          damaged,
          mismatched,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer?.files?.[0]
    if (f) void importFile(f)
  }

  const filters: [Filter, string][] = [["all", "All"], ["pipeline", "Pipelines"], ["experiment", "Experiments"]]

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page flex flex-col gap-4 pb-8">
        <section className="learn-top flex max-w-[680px] flex-col gap-2">
          <h1 className="learn-display">Library</h1>
          <p className="learn-lead">
            Everything you saved: pipelines from Build and experiments from Compare.{" "}
            {demo
              ? "They are kept in this browser until you delete them. Export a file to keep them anywhere else, or to move them to another browser."
              : "They are kept in this browser. Export a file to back them up or move them."}{" "}
            <a href="/privacy" className="font-semibold text-primary underline underline-offset-4">
              What is kept, and for how long
            </a>
          </p>
        </section>

        {demo && soon.length ? (
          <div data-testid="upload-warning" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel bg-stale-wash px-3 py-2 text-stale">
            <p className="m-0 min-w-0 flex-[1_1_280px]">
              <b>
                {plural(soon.length, "saved item")} {soon.length === 1 ? "uses" : "use"} an upload that is deleted from the demo in {hoursWords(soonHours)}.
              </b>{" "}
              Uploads are kept for {ttlHours} hours. The saved settings stay. Only the PDF goes.
            </p>
            <Button variant="outline" onClick={() => startExport(soon.map(key), true)}>
              Export them with the document
            </Button>
          </div>
        ) : null}

        {notice ? (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel bg-accent-wash px-3 py-2 text-fg">
            <p className="m-0 min-w-0 flex-[1_1_280px]">{notice}</p>
            <Button variant="ghost" onClick={() => setNotice(null)}>
              Done
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="group" aria-label="Show" className="inline-flex flex-wrap gap-1 rounded-control bg-surface-elevated p-1">
            {filters.map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(filter === value ? "border-primary bg-accent-wash text-primary hover:bg-accent-wash" : "text-fg-muted hover:text-fg")}
              >
                {label} <span className="font-mono text-xs">{counts[value]}</span>
              </Button>
            ))}
          </div>
          <span className="flex-1" />
          <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
            Import a file
          </Button>
          <Button variant="outline" disabled={!items.length || busy} onClick={() => startExport(items.map(key))}>
            Export everything
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label="Import a file"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              e.currentTarget.value = ""
              if (f) void importFile(f)
            }}
          />
        </div>

        {exporting ? (
          <section role="dialog" aria-label={`Export ${chosen.length === 1 ? chosen[0].name : plural(chosen.length, "item")}`} className="flex max-w-[560px] flex-col gap-3 rounded-panel border border-hairline bg-surface-raised p-4 shadow-sheet">
            <h2 className="learn-h2">Export {chosen.length === 1 ? chosen[0].name : plural(chosen.length, "item")}</h2>
            <p className="m-0 text-sm text-fg-muted">One file with the settings. Your browser saves it where it saves downloads, or asks you where, if you set it to.</p>
            {exportable.length ? (
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-1 size-[18px] accent-(--accent)" checked={withDoc} onChange={(e) => setWithDoc(e.currentTarget.checked)} />
                <span className="text-sm">
                  <b>Include the {exportable.length === 1 ? "document" : "documents"}</b>
                  <br />
                  <span className="text-fg-muted">
                    {listWords(exportable.map((d) => d.filename))}, about {size(exportable.reduce((n, d) => n + d.size, 0))}.{" "}
                    {demo
                      ? `Without ${exportable.length === 1 ? "it" : "them"}, importing later asks you to upload the ${exportable.length === 1 ? "PDF" : "PDFs"} again, because the demo keeps uploads for ${ttlHours} hours.`
                      : `Without ${exportable.length === 1 ? "it" : "them"}, importing in another copy of RAG Playground asks you to upload the ${exportable.length === 1 ? "PDF" : "PDFs"} again.`}
                  </span>
                </span>
              </label>
            ) : null}
            <p className="m-0 rounded-control bg-surface-elevated px-3 py-2 font-mono text-xs break-all">{exportFileName(chosen, now)}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setExporting(null)}>
                Cancel
              </Button>
              <Button busy={busy} disabled={!chosen.length} onClick={() => void doExport()}>
                Export
              </Button>
            </div>
          </section>
        ) : null}

        {shown.length ? (
          <ul aria-label="Saved items" className="m-0 flex list-none flex-col border-t border-hairline p-0">
            {shown.map((item) => {
              const k = key(item)
              const state = stateOf(item)
              return (
                <li key={k} className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-hairline px-1 py-3 md:grid-cols-[44px_minmax(0,1fr)_auto]">
                  <label className="grid min-h-[44px] cursor-pointer place-items-center self-start">
                    <input
                      type="checkbox"
                      className="size-[18px] accent-(--accent)"
                      aria-label={`Select ${item.name}`}
                      checked={picked.has(k)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked
                        setPicked((p) => {
                          const next = new Set(p)
                          if (on) next.add(k)
                          else next.delete(k)
                          return next
                        })
                      }}
                    />
                  </label>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <h2 className="m-0 min-w-0 text-base font-semibold break-words">{item.name}</h2>
                      <span className={cn("rounded-control px-2 text-xs font-semibold", item.kind === "experiment" ? "bg-accent-wash text-primary" : "bg-surface-elevated text-fg-muted")}>
                        {item.kind === "experiment" ? "Experiment" : "Pipeline"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
                      <span className="min-w-0 break-words">{item.kind === "pipeline" ? pipelineSummary(item.pipeline.graph) : experimentSummary(item.experiment)}</span>
                      <span>{savedWhen(item.savedAt, now)}</span>
                    </div>
                    <DocLine item={item} state={state} demo={demo} />
                  </div>
                  <div className="col-start-2 flex flex-wrap gap-2 md:col-start-3 md:justify-end">
                    <Button onClick={() => void open(item)}>Open in {item.kind === "experiment" ? "Compare" : "Build"}</Button>
                    <Button variant="outline" onClick={() => startExport([k])}>
                      Export
                    </Button>
                    <Button variant="ghost" className="text-danger" aria-label={`Delete ${item.name}`} onClick={() => remove(item)}>
                      Delete
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="m-0 border-t border-hairline px-1 py-6 text-fg-muted">
            {items.length
              ? "Nothing of this kind yet."
              : "Nothing saved yet. Save a pipeline on Build, or an experiment on Compare, and it appears here. You can also import a file you exported before."}
          </p>
        )}

        {picked.size ? (
          <div role="region" aria-label="Selection" className="sticky bottom-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-hairline bg-surface-raised px-3 py-2 shadow-sheet">
            <span>{plural(picked.size, "item")} picked</span>
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
            <Button onClick={() => startExport([...picked])}>Export {picked.size === 1 ? "it" : "them"}</Button>
          </div>
        ) : null}

        <div
          data-testid="import-drop"
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn("flex flex-col items-start gap-1 rounded-panel border-[1.5px] border-dashed p-4", over ? "border-primary bg-accent-wash" : "border-flat")}
        >
          <b>Bring back a saved file</b>
          <p className="m-0 text-sm text-fg-muted">
            Drop a <span className="font-mono text-xs">.ragplayground.json</span> file here, or{" "}
            <button type="button" className="font-semibold text-primary underline underline-offset-4" onClick={() => fileInput.current?.click()}>
              choose one
            </button>
            . Items you already have are not duplicated.
          </p>
        </div>
      </div>
      <SiteFooter />
    </main>
  )
}
