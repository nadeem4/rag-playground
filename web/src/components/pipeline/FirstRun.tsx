import { useState } from "react"

import { loadSample, useSamples } from "@/api/samples"
import type { Source } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { Button } from "@/components/ui/button"

import { SourcePicker, type SourceConfig } from "./SourcePicker"

/**
 * The Load card on a first visit (plan I-15): nothing uploaded and no file
 * selected. Upload your own through the usual picker, or load one of the
 * bundled samples (`GET /api/samples`, then `POST /api/sources/sample`).
 * Nothing runs until the user presses Run. A hosted demo has no Upload, and
 * says so in one line.
 *
 * The embedded `SourcePicker` hides its own sample select (F2): this card
 * already lists every sample, and offering the same choice twice, through two
 * different code paths, is how a sample used to load with the wrong question.
 */

const REPO = "https://github.com/nadeem4/rag-playground"
export function FirstRun({ onSource, onSample }: { onSource: (v: SourceConfig) => void; onSample: (s: Source, question: string) => void }) {
  const { samples, error: samplesError } = useSamples()
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const demo = useDemo()

  async function load(name: string, title: string, question: string) {
    setBusy(name)
    setLoadError(null)
    try {
      onSample(await loadSample(name), question)
    } catch (err) {
      setLoadError(`Could not load ${title}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Load" className="flex min-w-0 flex-col gap-3 border-b border-hairline bg-surface p-3">
      <h3 className="text-sm font-semibold">Load</h3>
      {demo ? (
        <p data-testid="demo-note" className="text-sm text-fg-muted">
          This is a hosted demo with sample documents. To use your own PDFs,{" "}
          <a href={REPO} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            run it locally
          </a>
          .
        </p>
      ) : (
        <div className="rounded-panel border border-dashed border-field-border p-3">
          <SourcePicker value={{}} onChange={onSource} samples={false} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 text-sm font-medium">Try a sample document</h4>
        {samplesError ? (
          <p role="alert" className="text-xs break-words text-danger">
            Could not list the samples: {samplesError}
          </p>
        ) : samples === null ? (
          <p role="status" className="text-xs text-fg-muted">
            Loading the samples
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {samples.map((s) => (
              <li key={s.name} className="flex min-w-0 flex-col gap-1 rounded-panel border border-hairline p-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h5 className="m-0 text-sm font-semibold">{s.title}</h5>
                  <span className="meta">{s.stresses}</span>
                </div>
                <p className="m-0 text-xs text-fg-muted">{s.blurb}</p>
                <p className="m-0 text-xs text-fg-muted">{s.shows}</p>
                <Button
                  size="sm"
                  variant={s.default ? "default" : "outline"}
                  className="self-start"
                  disabled={busy !== null}
                  onClick={() => void load(s.name, s.title, s.question)}
                >
                  {busy === s.name ? "Loading" : "Load"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {loadError ? (
          <p role="alert" data-testid="sample-error" className="text-xs break-words text-danger">
            {loadError}
          </p>
        ) : null}
      </div>
    </section>
  )
}
