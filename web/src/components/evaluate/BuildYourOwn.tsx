import { useId, useRef, useState } from "react"

import type { Registry, Stage } from "@/api/types"
import { RERANKERS, RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { CONTROL } from "@/components/fields/types"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { plainName } from "@/components/pipeline/NodeCard"
import { TransformSelect } from "@/components/pipeline/TransformSelect"
import { Button } from "@/components/ui/button"
import { Picker, type PickerOption } from "@/components/ui/Picker"
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl"
import { firstSentence } from "@/lib/sentence"
import { cn } from "@/lib/utils"
import type { DocRef } from "@/state/document"
import {
  addCleaner,
  removeNode,
  rerankerOf,
  rewriteOf,
  setReranker,
  setRewrite,
  setTransform,
  transformsFor,
  upstreamFor,
  type PipelineGraph,
  type RewriteMode,
} from "@/state/graph"

import { SideSheet } from "./SideSheet"

/**
 * Build your own, on Evaluate: one side sheet with a name, the documents, and
 * one setting per stage, prefilled from the selected pipeline. The settings
 * are Build's own pickers (TransformSelect, the reranker list, the rewrite
 * switch) over a draft copy of the graph, so this is not a second Build. Save
 * and select saves it as a pipeline; the link opens Build with the draft.
 */

const NAME_ERROR = "Give it a name, so you can find it in the list."

export function BuildYourOwn({
  registry,
  from,
  documents,
  onSave,
  onOpenBuild,
  replacesUnsaved,
  onClose,
}: {
  registry: Registry
  /** The selected pipeline: where the settings start. */
  from: { name: string; graph: PipelineGraph }
  documents: DocRef[]
  /** Save it; the reason when it could not be saved, else null. */
  onSave: (name: string, graph: PipelineGraph) => string | null
  onOpenBuild: (graph: PipelineGraph) => void
  /** Build has an unsaved pipeline the link would replace. */
  replacesUnsaved: boolean
  onClose: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(from.graph)
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  function save() {
    if (!name.trim()) {
      setError(NAME_ERROR)
      nameRef.current?.focus()
      return
    }
    const why = onSave(name.trim(), draft)
    if (why) setError(why)
  }

  const nodeOf = (stage: Stage) => draft.nodes.find((n) => n.stage === stage)
  const transformRow = (stage: Stage, label: string, labelFor: (n: string) => string = plainName) => {
    const node = nodeOf(stage)
    if (!node) return null
    return (
      <div className={ROW}>
        <TransformSelect
          id={`${id}-${stage}`}
          label={label}
          transforms={transformsFor(registry, stage)}
          value={node.transform}
          upstream={upstreamFor(draft, registry, node.id)}
          labelFor={labelFor}
          onChange={(t) => setDraft((g) => setTransform(g, node.id, t, registry))}
        />
      </div>
    )
  }

  const cleaner = nodeOf("clean")
  const cleanOptions: PickerOption[] = [
    { value: "", name: "None", help: "Chunk reads the parsed document as it is." },
    ...transformsFor(registry, "clean").map((t) => ({ value: t.name, name: plainName(t.name), code: t.name, help: t.summary ? firstSentence(t.summary) : undefined })),
  ]
  function setClean(value: string) {
    setDraft((g) => {
      if (!value) return g.nodes.filter((n) => n.stage === "clean").reduce((acc, n) => removeNode(acc, n.id), g)
      const existing = g.nodes.find((n) => n.stage === "clean")
      const withOne = existing ? g : addCleaner(g, registry)
      const node = withOne.nodes.find((n) => n.stage === "clean")
      return node ? setTransform(withOne, node.id, value, registry) : g
    })
  }

  const rerankOptions: PickerOption[] = RERANKERS.filter((r) => r.name === null || registry.rerank?.[r.name]).map((r) => {
    if (r.name === null) return { value: "", name: "No reranker", help: "Keeps the search order as it is." }
    const summary = registry.rerank?.[r.name]?.summary
    return { value: r.name, name: r.label, code: r.name, help: summary ? firstSentence(summary) : undefined }
  })

  const rewrites: SegmentedOption[] = [{ value: "none", label: "None" }]
  if (registry.retrieve?.hybrid_rrf?.config_schema.properties?.query_expansion) rewrites.push({ value: "prf", label: "PRF" })
  if (registry.query?.llm_rewrite) rewrites.push({ value: "llm", label: "LLM" })

  const footer = (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <button type="button" className={cn(LINK_BUTTON, "inline-flex items-center self-start text-sm underline")} onClick={() => onOpenBuild(draft)}>
          Open on Build to watch each step
        </button>
        {replacesUnsaved ? <span className="text-xs text-fg-muted">This replaces the unsaved pipeline on Build.</span> : null}
      </div>
      <Button onClick={save}>Save and select</Button>
    </>
  )

  return (
    <SideSheet title="Build your own pipeline" onClose={onClose} footer={footer}>
      <p className="text-sm text-fg-muted">Starts from {from.name}. Change any step, give it a name, and save.</p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs text-fg-muted">
          Name
        </label>
        <input
          ref={nameRef}
          id={`${id}-name`}
          type="text"
          autoComplete="off"
          maxLength={60}
          value={name}
          aria-invalid={error === NAME_ERROR || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          className={CONTROL}
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Documents</span>
        <span className="font-mono text-sm break-words">{documents.map((d) => d.filename).join(", ") || "None yet"}</span>
        <span className="text-xs text-fg-muted">Change them under the pipeline picker.</span>
      </div>
      <section aria-label="Index side" className="flex flex-col gap-3">
        <h3 className="meta">Index side</h3>
        {transformRow("parse", "Parse")}
        <div className={ROW}>
          <label id={`${id}-clean-label`} htmlFor={`${id}-clean`} className="text-sm font-medium">
            Clean
          </label>
          <Picker id={`${id}-clean`} labelledBy={`${id}-clean-label`} options={cleanOptions} value={cleaner?.transform ?? ""} onChange={setClean} />
        </div>
        {transformRow("chunk", "Chunk")}
        {transformRow("index", "Index")}
      </section>
      <section aria-label="Search side" className="flex flex-col gap-3">
        <h3 className="meta">Search side</h3>
        <div className={ROW}>
          <span className="text-sm font-medium">Rewrite</span>
          <SegmentedControl label="Rewrite" options={rewrites} value={rewriteOf(draft)} onChange={(v) => setDraft((g) => setRewrite(g, registry, v as RewriteMode))} />
        </div>
        {transformRow("retrieve", "Retrieve", (n) => RETRIEVAL_LABEL[n] ?? n)}
        <div className={ROW}>
          <label id={`${id}-rerank-label`} htmlFor={`${id}-rerank`} className="text-sm font-medium">
            Rerank
          </label>
          <Picker
            id={`${id}-rerank`}
            labelledBy={`${id}-rerank-label`}
            options={rerankOptions}
            value={rerankerOf(draft) ?? ""}
            onChange={(v) => setDraft((g) => setReranker(g, registry, v || null))}
          />
        </div>
      </section>
    </SideSheet>
  )
}

/** A stage's row: its name, then its control; side by side from md, stacked on a phone. */
const ROW = "grid grid-cols-1 items-center gap-x-3 gap-y-1 md:grid-cols-[5.5rem_minmax(0,1fr)]"
