import { useEffect, useId, useState } from "react"

import type { Registry } from "@/api/types"
import type { PipelineGraph } from "@/state/graph"
import { CONTROL } from "@/components/fields/types"
import { Button } from "@/components/ui/button"
import {
  deletePipeline,
  droppedText,
  encodePipeline,
  renamePipeline,
  sameGraph,
  savePipeline,
  setCurrentId,
  updatePipeline,
  usableGraph,
  usePipelines,
} from "@/state/pipelines"

/**
 * Saved pipelines: the select picks one into the working copy, and the buttons
 * save the working copy back. "Working copy" is whatever is on screen; picking
 * it never changes the graph, only the selection. A saved pipeline this
 * server cannot run is listed, disabled, and never loaded (M7).
 */
export function PipelineBar({
  graph,
  registry,
  onLoad,
  notice,
}: {
  graph: PipelineGraph
  registry: Registry
  onLoad: (g: PipelineGraph) => void
  notice?: string | null
}) {
  const id = useId()
  const { pipelines, currentId } = usePipelines()
  const current = pipelines.find((p) => p.id === currentId) ?? null
  const edited = current !== null && !sameGraph(current.graph, graph)
  const [naming, setNaming] = useState<"save" | "rename" | null>(null)
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [linkText, setLinkText] = useState<string | null>(null)

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
    const saved = naming === "rename" && current ? null : savePipeline(name, graph)
    const ok = naming === "rename" && current ? renamePipeline(current.id, name) : saved !== null
    if (!ok) {
      setNameError(name.trim() ? "The pipeline could not be saved in this browser." : "Give the pipeline a name.")
      return
    }
    if (saved?.dropped) setFlash(droppedText(saved.dropped))
    setNaming(null)
    setName("")
    setNameError(null)
  }

  async function copyLink() {
    if (!current) return
    const url = `${window.location.origin}/build?pipeline=${encodePipeline(current.name, current.graph)}`
    try {
      await navigator.clipboard.writeText(url)
      setFlash("Link copied")
    } catch {
      setLinkText(url)
    }
  }

  return (
    <div role="group" aria-label="Saved pipelines" className="flex flex-col gap-2 border-b border-hairline px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-pick`} className="text-sm text-fg-muted">Pipeline</label>
        <select
          id={`${id}-pick`}
          className={`${CONTROL} w-auto`}
          value={currentId ?? ""}
          onChange={(e) => {
            const picked = pipelines.find((p) => p.id === e.target.value) ?? null
            const loaded = picked ? usableGraph(picked, registry) : null
            if (picked && !loaded) return
            setCurrentId(picked?.id ?? null)
            if (loaded) onLoad(loaded)
          }}
        >
          <option value="">Working copy</option>
          {pipelines.map((p) => {
            const usable = usableGraph(p, registry) !== null
            return (
              <option key={p.id} value={p.id} disabled={!usable}>
                {usable ? p.name : `${p.name} (not usable here)`}
              </option>
            )
          })}
        </select>
        {edited ? <span className="meta">edited</span> : null}
        {current ? (
          <Button size="sm" variant="outline" disabled={!edited} onClick={() => setFlash(updatePipeline(current.id, graph) ? "Saved" : "The pipeline could not be saved in this browser.")}>Save changes</Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => { setNaming("save"); setName(""); setNameError(null) }}>Save as</Button>
        {current ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => { setNaming("rename"); setName(current.name); setNameError(null) }}>Rename</Button>
            <Button size="sm" variant="ghost" onClick={() => deletePipeline(current.id)}>Delete</Button>
            <Button size="sm" variant="ghost" disabled={edited} title={edited ? "Save changes first" : undefined} onClick={() => void copyLink()}>
              Copy link
            </Button>
          </>
        ) : null}
        {flash ? <span role="status" className="text-xs text-fg-muted">{flash}</span> : null}
      </div>
      {naming ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); commitName() }}>
          <input aria-label="Pipeline name" className={`${CONTROL} w-[240px]`} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button size="sm" type="submit">Save</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(null)}>Cancel</Button>
          {nameError ? <span role="alert" className="text-xs text-danger">{nameError}</span> : null}
        </form>
      ) : null}
      {linkText ? <input readOnly aria-label="Share link" className={`${CONTROL} font-mono text-xs`} value={linkText} onFocus={(e) => e.currentTarget.select()} /> : null}
      {notice ? <p role="status" className="text-xs text-fg-muted">{notice}</p> : null}
    </div>
  )
}
