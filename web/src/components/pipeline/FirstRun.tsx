import { useState } from "react"

import { api } from "@/api/client"
import type { Source } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { Button } from "@/components/ui/button"

import { SourcePicker, type SourceConfig } from "./SourcePicker"

type SampleState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }

/**
 * The Load card on a first visit (plan I-15): nothing uploaded and no file
 * selected. Upload your own through the usual picker, or register the bundled
 * sample (`POST /api/sources/sample`). Nothing runs until the user presses Run.
 * A hosted demo has no Upload, and says so in one line.
 */

const REPO = "https://github.com/nadeem4/rag-playground"
export function FirstRun({ onSource, onSample }: { onSource: (v: SourceConfig) => void; onSample: (s: Source) => void }) {
  const [state, setState] = useState<SampleState>({ kind: "idle" })
  const demo = useDemo()

  async function loadSample() {
    setState({ kind: "loading" })
    try {
      onSample(await api.sampleSource())
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const loading = state.kind === "loading"
  return (
    <section aria-label="Load" className="flex min-w-0 flex-col gap-3 border-b border-hairline bg-surface p-3">
      <h3 className="text-sm font-semibold">Load</h3>
      {demo ? (
        <p data-testid="demo-note" className="text-sm text-fg-muted">
          This is a hosted demo with a sample document. To use your own PDFs,{" "}
          <a href={REPO} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            run it locally
          </a>
          .
        </p>
      ) : (
        <div className="rounded-panel border border-dashed border-field-border p-3">
          <SourcePicker value={{}} onChange={onSource} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <Button data-testid="try-sample" className="self-start" disabled={loading} onClick={() => void loadSample()}>
          {loading ? "Loading the sample" : "Try the sample document"}
        </Button>
        <p className="text-xs text-fg-muted">
          Three pages of notes on chunking, written for this playground. It has headings, a running footer and a repeated paragraph,
          so every step has something to show.
        </p>
        {state.kind === "error" ? (
          <p role="alert" data-testid="sample-error" className="text-xs break-words text-danger">
            Could not load the sample: {state.message}
          </p>
        ) : null}
      </div>
    </section>
  )
}
