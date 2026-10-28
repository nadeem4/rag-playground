import { useEffect, useRef, useState } from "react"

import { CONTROL } from "@/components/fields/types"
import { Button } from "@/components/ui/button"
import type { PipelineGraph } from "@/state/graph"
import { stageNode } from "@/state/guide"
import { droppedText, savePipeline, saveRefusal, type SavedPipeline } from "@/state/pipelines"

interface Props {
  graph: PipelineGraph
  rule: string
  onSaved: (saved: SavedPipeline) => void
  onOwn: () => void
  onLeave: () => void
}

/** The last guided step: the rule, then keep the pipeline in the Library. */
export function GuideEnd({ graph, rule, onSaved, onOwn, onLeave }: Props) {
  const size = stageNode(graph, "chunk")?.config.chunk_size
  const [name, setName] = useState(typeof size === "number" ? `Chunks of ${size}` : "")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedPipeline | null>(null)
  const [dropped, setDropped] = useState("")

  function save() {
    const made = savePipeline(name, graph)
    if (!made) {
      setError(saveRefusal(name))
      return
    }
    setError(null)
    setSaved(made.saved)
    setDropped(made.dropped ? droppedText(made.dropped) : "")
    onSaved(made.saved)
  }
  const tryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (saved) tryRef.current?.focus()
  }, [saved])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-sm text-fg">{rule}</p>
      {saved ? (
        <>
          <p role="status" className="m-0 text-sm text-fg">
            {`${saved.name} is in your Library. Save as at the top of Build does the same later.${dropped ? ` ${dropped}` : ""}`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button ref={tryRef} onClick={onOwn}>Try it on your own document</Button>
            <Button variant="ghost" onClick={onLeave}>
              Keep playing here
            </Button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <label className="text-sm font-semibold text-fg" htmlFor="guide-keep-name">
            Keep this pipeline
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="guide-keep-name"
              className={`${CONTROL} min-w-0 w-[240px]`}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit">Save</Button>
          </div>
          {error ? (
            <span role="alert" className="text-xs text-danger">
              {error}
            </span>
          ) : null}
        </form>
      )}
    </div>
  )
}
