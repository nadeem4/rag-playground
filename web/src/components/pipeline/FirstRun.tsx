import { useRef, useState } from "react"
import { Upload } from "lucide-react"

import { useSamples } from "@/api/samples"
import { useAppSettings } from "@/api/useDemo"
import { useUpload } from "@/components/useUpload"
import { Button } from "@/components/ui/button"
import { loadSampleDocument } from "@/state/document"

/**
 * The first-visit card on Build (plan I-15): no document yet. Load one of the
 * bundled samples (`GET /api/samples`, then `POST /api/sources/sample`), or
 * upload a PDF; either becomes the document in the header's bar. This
 * browser's earlier uploads are in the bar's menu. Nothing runs until the
 * user presses Run. A hosted demo states its limits in a note.
 */

const REPO = "https://github.com/nadeem4/rag-playground"
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
const count = (n: number) => WORDS[n] ?? String(n)
export function FirstRun() {
  const { samples, error: samplesError } = useSamples()
  const { upload, busy: uploading, error: uploadError } = useUpload()
  const fileRef = useRef<HTMLInputElement>(null)
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
      await loadSampleDocument({ name, question })
    } catch (err) {
      setLoadError(`Could not load ${title}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Document" className="flex min-w-0 flex-col gap-3 border-b border-hairline bg-surface p-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Document</h3>
        <p className="m-0 text-sm text-fg-muted">Or pick one in the bar above.</p>
      </div>
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
      <div className="flex min-w-0 flex-col gap-2 rounded-panel border border-dashed border-field-border p-3">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf"
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload a PDF file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            void upload(file)
          }}
        />
        <Button variant="outline" size="sm" className="self-start" busy={uploading !== null} onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden strokeWidth={1.75} />
          {uploading ? `Uploading ${uploading}` : "Upload a PDF"}
        </Button>
        {uploadError ? (
          <p role="alert" className="text-xs break-words text-danger">
            {uploadError}
          </p>
        ) : null}
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
