import { useEffect, useId, useState } from "react"

import type { Registry } from "@/api/types"
import { CONTROL } from "@/components/fields/types"
import { TakeHome } from "@/components/pipeline/TakeHome"
import { TemplatePicker, type UsedTemplate } from "@/components/pipeline/TemplatePicker"
import { Button } from "@/components/ui/button"
import { Picker, type PickerOption } from "@/components/ui/Picker"
import { documentsOf, withDocuments } from "@/state/document"
import { pipelineLine } from "@/state/evaluate"
import { initialGraph, type PipelineGraph } from "@/state/graph"
import { graphToConfig, removedText, sameConfig, type WorkingPipeline } from "@/state/config"
import {
  cleanSavedPipeline,
  deletePipeline,
  droppedText,
  encodePipeline,
  isEdited,
  keptReason,
  renamePipeline,
  saveRefusal,
  savePipeline,
  setCurrentId,
  STARTER_ID,
  updatePipeline,
  usableGraph,
  usePipelines,
} from "@/state/pipelines"
import type { StarterPipeline } from "@/state/starter"

/** The same config, documents and question, whatever the order of their keys. */
function samePipeline(a: WorkingPipeline, b: WorkingPipeline): boolean {
  return sameConfig(a.config, b.config) && JSON.stringify([a.documents, a.question]) === JSON.stringify([b.documents, b.question])
}

/**
 * Build's top line, pipeline first: the Pipeline picker (the ready-made
 * Starter, your saved pipelines, and New), then the pipeline's documents with
 * Change. Picking one loads it into the working copy. Editing a step marks it
 * edited: a saved pipeline offers Save and Save as new; the Starter is
 * read-only, so it offers Save as new only. A saved pipeline this server
 * cannot run is listed, disabled, and never loaded (M7). Opened from
 * Evaluate's Build your own, it shows Back to Evaluate, and a save goes back
 * there with the pipeline selected (`onSaved`).
 *
 * Take it home opens a sheet that downloads the
 * pipeline as a ready-to-run project zip (`TakeHome`).
 *
 * Start from a template opens the template picker, and so does opening Build
 * at /build?templates=1 (the query is then dropped). Using a template replaces
 * the pipeline with an unsaved one and shows a status line whose Undo puts
 * back the pipeline, and the picker's selection, exactly as they were. Any
 * later change to the pipeline removes the line, so Undo never drops an edit.
 */
export function PipelineBar({
  graph,
  registry,
  starter,
  onLoad,
  notice,
  fromEvaluate = false,
  onSaved,
}: {
  graph: PipelineGraph
  registry: Registry
  /** The ready-made Starter, once the samples list has answered. */
  starter: StarterPipeline | null
  /** `note` says which settings the server does not allow were dropped on the way in. */
  onLoad: (g: PipelineGraph, note?: string) => void
  notice?: string | null
  /** Opened from Evaluate: show Back to Evaluate. */
  fromEvaluate?: boolean
  /** A pipeline was saved, under this id. */
  onSaved?: (id: string) => void
}) {
  const id = useId()
  const { pipelines, currentId } = usePipelines()
  const saved = pipelines.find((p) => p.id === currentId) ?? null
  const current = currentId === STARTER_ID ? starter : saved
  const edited = current !== null && isEdited(current, graph)
  const [naming, setNaming] = useState<"save" | "rename" | null>(null)
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [linkText, setLinkText] = useState<string | null>(null)
  // /build?templates=1 (Home's "Start from a template") opens the picker once.
  const [choosing, setChoosing] = useState(() => new URLSearchParams(window.location.search).get("templates") === "1")
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has("templates")) return
    params.delete("templates")
    const rest = params.toString()
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""))
  }, [])
  const [applied, setApplied] = useState<{ line: string; graph: PipelineGraph; id: string | null; used: WorkingPipeline | null } | null>(null)
  const working = graphToConfig(graph)

  // The pipeline is no longer the one the template made: the visitor changed it, so Undo goes.
  const now = working.ok ? working.pipeline : null
  useEffect(() => {
    if (applied && !(applied.used && now && samePipeline(applied.used, now))) setApplied(null)
  }, [applied, now])

  // A half-typed name or a share link belongs to the pipeline it was for (M5).
  useEffect(() => {
    setNaming(null)
    setName("")
    setNameError(null)
    setLinkText(null)
  }, [currentId])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 3000)
    return () => window.clearTimeout(t)
  }, [flash])

  function commitName() {
    const made = naming === "rename" && saved ? null : savePipeline(name, graph)
    const ok = naming === "rename" && saved ? renamePipeline(saved.id, name) : made !== null
    if (!ok) {
      setNameError(saveRefusal(name, naming !== "rename"))
      return
    }
    if (made?.dropped) setFlash(droppedText(made.dropped))
    setNaming(null)
    setName("")
    setNameError(null)
    if (made) onSaved?.(made.saved.id)
  }

  function saveInPlace() {
    if (!saved) return
    const ok = updatePipeline(saved.id, graph)
    setFlash(ok ? "Saved" : "The pipeline could not be saved in this browser.")
    if (ok) onSaved?.(saved.id)
  }

  async function copyLink() {
    if (!saved) return
    const drawn = usableGraph(saved, registry)
    if (!drawn) return
    const url = `${window.location.origin}/build?pipeline=${encodePipeline(saved.name, drawn, saved.documents)}`
    try {
      await navigator.clipboard.writeText(url)
      setFlash("Link copied")
    } catch {
      setLinkText(url)
    }
  }

  const editedTag = [{ label: "Edited since saved", tone: "soft" as const }]
  const options: PickerOption[] = [
    ...(starter
      ? [
          {
            value: STARTER_ID,
            name: starter.name,
            help: pipelineLine(starter.graph),
            group: "Ready to use",
            tags: [{ label: "Ready-made", tone: "plain" as const }, ...(currentId === STARTER_ID && edited ? editedTag : [])],
          },
        ]
      : []),
    ...pipelines.map((p) => {
      const usable = usableGraph(p, registry)
      return {
        value: p.id,
        name: p.name,
        help: usable ? pipelineLine(usable) : "",
        group: "Your pipelines",
        lock: usable
          ? undefined
          : { kind: "hard" as const, reason: keptReason(p.kept?.problem) },
        tags: p.id === saved?.id && edited ? editedTag : undefined,
      }
    }),
    // Selected, New is the unsaved pipeline on screen; otherwise it is the action that starts one.
    current
      ? { value: "", name: "New pipeline", help: "Start from the Starter's settings on this document.", action: true }
      : { value: "", name: "New pipeline", help: pipelineLine(graph), tags: [{ label: "Not saved", tone: "soft" as const }] },
  ]

  function applyTemplate(used: UsedTemplate) {
    const made = graphToConfig(used.graph)
    setApplied({ line: used.line, graph, id: currentId, used: made.ok ? made.pipeline : null })
    setChoosing(false)
    setCurrentId(null)
    onLoad(used.graph, used.note)
  }

  function undoTemplate() {
    if (!applied) return
    setCurrentId(applied.id)
    onLoad(applied.graph)
    setApplied(null)
    // The Undo button goes away with its line, so focus moves to the button that started it.
    document.getElementById(`${id}-template`)?.focus()
  }

  function pick(value: string) {
    setApplied(null)
    if (value === "") {
      // New: the Starter's settings on the documents in use, not saved yet.
      setCurrentId(null)
      onLoad(withDocuments(starter?.graph ?? initialGraph(registry), documentsOf(graph)))
      return
    }
    if (value === STARTER_ID) {
      if (!starter) return
      setCurrentId(STARTER_ID)
      onLoad(starter.graph)
      return
    }
    const picked = pipelines.find((p) => p.id === value) ?? null
    const loaded = picked ? usableGraph(picked, registry) : null
    if (!picked || !loaded) return
    // Drawn without any setting the server does not allow; the saved copy loses it too.
    const removed = cleanSavedPipeline(picked.id, registry)
    setCurrentId(picked.id)
    onLoad(loaded, removedText(removed) ?? undefined)
  }

  return (
    <div role="group" aria-label="Pipeline" className="flex flex-col gap-2 border-b border-hairline px-3 py-2">
      {fromEvaluate ? (
        <a href="/evaluate" className="inline-flex min-h-[1.5rem] items-center self-start text-sm text-primary underline underline-offset-4">
          ‹ Back to Evaluate
        </a>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label id={`${id}-label`} htmlFor={`${id}-pick`} className="text-sm text-fg-muted">
          Pipeline
        </label>
        <Picker id={`${id}-pick`} labelledBy={`${id}-label`} className="w-[min(320px,100%)]" options={options} value={currentId && current ? currentId : ""} onChange={pick} />
        {edited ? <span className="meta">edited</span> : null}
        {working.ok ? (
          <Button id={`${id}-template`} size="sm" variant="outline" onClick={() => setChoosing(true)}>
            Start from a template
          </Button>
        ) : null}
      </div>
      {applied ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-accent-wash px-3 py-2">
          <p className="text-sm text-fg">{applied.line}</p>
          <Button size="sm" variant="outline" onClick={undoTemplate}>
            Undo
          </Button>
        </div>
      ) : null}
      {choosing && working.ok ? (
        <TemplatePicker
          registry={registry}
          current={{ documents: working.pipeline.documents, question: working.pipeline.question }}
          onUse={applyTemplate}
          onClose={() => setChoosing(false)}
        />
      ) : null}
      {naming ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            commitName()
          }}
        >
          <input aria-label="Pipeline name" className={`${CONTROL} w-[240px]`} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button size="sm" type="submit">
            Save
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(null)}>
            Cancel
          </Button>
          {nameError ? (
            <span role="alert" className="text-xs text-danger">
              {nameError}
            </span>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {saved ? (
            <Button size="sm" variant="outline" disabled={!edited} onClick={saveInPlace}>
              Save
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setNaming("save")
              setName("")
              setNameError(null)
            }}
          >
            Save as new
          </Button>
          {saved ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNaming("rename")
                  setName(saved.name)
                  setNameError(null)
                }}
              >
                Rename
              </Button>
              <Button size="sm" variant="ghost" onClick={() => deletePipeline(saved.id)}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" disabled={edited} title={edited ? "Save first" : undefined} onClick={() => void copyLink()}>
                Copy link
              </Button>
            </>
          ) : null}
          {working.ok ? <TakeHome graph={graph} name={current?.name ?? ""} pipelineKey={current ? currentId : null} registry={registry} /> : null}
          {flash ? (
            <span role="status" className="text-xs text-fg-muted">
              {flash}
            </span>
          ) : null}
        </div>
      )}
      {linkText ? <input readOnly aria-label="Share link" className={`${CONTROL} font-mono text-xs`} value={linkText} onFocus={(e) => e.currentTarget.select()} /> : null}
      {notice ? (
        <p role="status" className="text-xs text-fg-muted">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
