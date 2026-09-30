import { useState } from "react"

import { loadSample, useSamples } from "@/api/samples"
import type { Source } from "@/api/types"
import { useAppSettings } from "@/api/useDemo"
import { Button } from "@/components/ui/button"

import { SourcePicker, type SourceConfig } from "./SourcePicker"

/**
 * The Load card on a first visit (plan I-15): nothing uploaded and no file
 * selected. Upload your own through the usual picker, or load one of the
 * bundled samples (`GET /api/samples`, then `POST /api/sources/sample`).
 * Nothing runs until the user presses Run. A hosted demo still offers
 * Upload, and states its limits in a note above the picker.
 *
 * The embedded `SourcePicker` hides its own sample select (F2): this card
 * already lists every sample, and offering the same choice twice, through two
 * different code paths, is how a sample used to load with the wrong question.
 * It also hides its own reassurance sentence: this card already says, above
 * the picker, that the file is private or never leaves the machine.
 */

const REPO = "https://github.com/nadeem4/rag-playground"
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
const count = (n: number) => WORDS[n] ?? String(n)
export function FirstRun({ onSource, onSample }: { onSource: (v: SourceConfig) => void; onSample: (s: Source, question: string) => void }) {
  const { samples, error: samplesError } = useSamples()
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = settings?.limits
  const ttlHours = limits?.ttl_hours ?? 24
  // Inside the Hugging Face Space page the app is a cross-site iframe, where a
  // browser that blocks third-party cookies loses the visitor cookie.
  const framed = window.self !== window.top

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
    <section aria-label="Upload" className="flex min-w-0 flex-col gap-3 border-b border-hairline bg-surface p-3">
      <h3 className="text-sm font-semibold">Upload</h3>
      {demo ? (
        <p data-testid="demo-note" className="text-sm text-fg-muted">
          This is a hosted demo. A PDF you upload is private to this browser, is not shared with anyone, and is deleted after{" "}
          {ttlHours === 24 ? "a day" : `${ttlHours} hours`}. Files up to{" "}
          {Math.round((limits?.max_bytes ?? 10485760) / 1048576)} MB and {limits?.max_pages ?? 20} pages,{" "}
          {count(limits?.max_files ?? 3)} at a time. Clearing cookies loses access to your uploads. For anything larger,{" "}
          <a href={REPO} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            run it locally
          </a>
          .
          {framed ? (
            <>
              {" "}
              Uploads need cookies. If your browser blocks them here,{" "}
              <a href={window.location.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                open the demo in its own tab
              </a>
              .
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-fg-muted">Your files stay on this machine and never leave it.</p>
      )}
      <div className="rounded-panel border border-dashed border-field-border p-3">
        <SourcePicker value={{}} onChange={onSource} samples={false} reassure={false} />
      </div>
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
