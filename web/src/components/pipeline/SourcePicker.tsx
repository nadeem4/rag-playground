import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Upload } from "lucide-react"

import { api, ApiError } from "@/api/client"
import { loadSample as loadSampleApi, useSamples } from "@/api/samples"
import type { SampleCard, Source } from "@/api/types"
import { useAppSettings } from "@/api/useDemo"
import { Button } from "@/components/ui/button"
import { CONTROL } from "@/components/fields/types"

/**
 * The Load card's body: upload a file (`POST /api/sources`) or pick one
 * already uploaded (`GET /api/sources`). Emits the source node's config,
 * `{sha, filename}`. A hosted demo also offers Upload, bounded and private to
 * the browser.
 *
 * The file list has two groups: Samples, every bundled sample whether or not
 * anyone has loaded it, and Your uploads, the listed files that are not a
 * sample. Samples are public on the server, so without the split a visitor
 * would see every sample anyone loaded as if it were their own upload.
 */

export interface SourceConfig {
  sha?: string
  filename?: string
}

type ListState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: Source[] }

/** The server's own sentence when it sent one, so a visitor reads why without the status and path in front. */
const reason = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

export function SourcePicker({
  value,
  onChange,
  onSample,
  errors,
  samples: showSamples = true,
  reassure = true,
  limits: showLimits = true,
}: {
  value: SourceConfig
  onChange: (v: SourceConfig) => void
  /** Called with a picked sample's source and its own question, instead of `onChange`, when given. */
  onSample?: (src: Source, question: string) => void
  errors?: string[]
  /** Group the file list into Samples and Your uploads. False on the first-visit card (plan I-15, F2), which
   * already lists every sample of its own; its list then holds the files only. */
  samples?: boolean
  /** Show the "your files never leave/are not shared" sentence under the file select. False on the first-run
   * card (`FirstRun`), which already says this itself, above the embedded picker. */
  reassure?: boolean
  /** Show the "PDF only, up to ..." line under Upload. False on the first-run card (`FirstRun`), whose
   * demo note already states the limits. */
  limits?: boolean
}) {
  const id = useId()
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = demo ? settings?.limits : undefined
  const mb = limits ? Math.round(limits.max_bytes / 1048576) : 0
  const fileRef = useRef<HTMLInputElement>(null)
  const [list, setList] = useState<ListState>({ kind: "loading" })
  const [upload, setUpload] = useState<{ name: string; error?: string } | null>(null)
  const { samples } = useSamples()
  const [sampleBusy, setSampleBusy] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  // A sample loads asynchronously: answer through the latest callbacks, so an
  // edit made elsewhere meanwhile is not lost.
  const latest = useRef({ onChange, onSample })
  latest.current = { onChange, onSample }

  const refresh = useCallback(() => {
    api.sources().then(
      (items) => setList({ kind: "ready", items }),
      (err: unknown) => setList({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    )
  }, [])

  useEffect(refresh, [refresh])

  async function loadSample(card: SampleCard) {
    setSampleBusy(true)
    try {
      const src = await loadSampleApi(card.name)
      setSampleError(null)
      const { onChange, onSample } = latest.current
      if (onSample) onSample(src, card.question)
      else onChange({ sha: src.sha, filename: src.filename })
      refresh()
    } catch (err) {
      setSampleError(`Could not load ${card.title}: ${reason(err)}`)
    } finally {
      setSampleBusy(false)
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    const refuse = (error: string) => {
      setUpload({ name: file.name, error })
      if (fileRef.current) fileRef.current.value = ""
    }
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      refuse("Only PDF files can be uploaded.")
      return
    }
    if (limits && file.size > limits.max_bytes) {
      refuse(
        `This file is ${(file.size / 1048576).toFixed(1)} MB. The hosted demo takes files up to ${mb} MB. Or split out the pages you need and upload those.`,
      )
      return
    }
    setUpload({ name: file.name })
    try {
      const src = await api.uploadSource(file)
      setUpload(null)
      onChange({ sha: src.sha, filename: src.filename })
      refresh()
    } catch (err) {
      setUpload({ name: file.name, error: reason(err) })
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const items = list.kind === "ready" ? list.items : []
  const invalid = Boolean(errors?.length)
  // Until the samples arrive the groups are unknown: one plain list, as on the first-visit card.
  const groups = showSamples && samples?.length ? samples : null
  const uploads = groups ? items.filter((i) => !groups.some((s) => s.sha === i.sha)) : items
  const currentSample = groups?.find((s) => s.sha === value.sha)
  const selected = currentSample ? `sample:${currentSample.name}` : uploads.some((s) => s.sha === value.sha) ? value.sha! : ""
  const uploadOptions = uploads.map((s) => (
    <option key={s.sha} value={s.sha}>
      {s.filename}
    </option>
  ))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-pick`} className="text-sm font-medium">
          File
        </label>
        {list.kind === "loading" ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading uploaded files
          </p>
        ) : list.kind === "error" ? (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-xs text-danger">Could not list uploaded files</p>
            <p className="font-mono text-xs break-all text-fg-muted">{list.message}</p>
            <Button variant="outline" size="sm" className="self-start" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : !groups && items.length === 0 ? (
          <p className="text-sm text-fg-muted">{demo ? "No files yet. Upload a PDF, or load a sample." : "No files uploaded yet. Upload a PDF to start."}</p>
        ) : (
          <select
            id={`${id}-pick`}
            className={CONTROL}
            value={selected}
            disabled={sampleBusy}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-err` : undefined}
            onChange={(e) => {
              const v = e.target.value
              const card = v.startsWith("sample:") ? groups?.find((s) => `sample:${s.name}` === v) : undefined
              if (card) {
                void loadSample(card)
                return
              }
              const s = uploads.find((x) => x.sha === v)
              if (s) onChange({ sha: s.sha, filename: s.filename })
            }}
          >
            {selected ? null : (
              <option value="" disabled>
                {value.filename ? `${value.filename} (missing)` : "Pick a file"}
              </option>
            )}
            {groups ? (
              <>
                <optgroup label="Samples">
                  {groups.map((s) => (
                    <option key={s.name} value={`sample:${s.name}`}>
                      {s.title}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Your uploads">
                  {uploads.length ? (
                    uploadOptions
                  ) : (
                    <option value="none" disabled>
                      No uploads yet
                    </option>
                  )}
                </optgroup>
              </>
            ) : (
              uploadOptions
            )}
          </select>
        )}
        {sampleError ? (
          <p role="alert" className="text-xs text-danger">
            {sampleError}
          </p>
        ) : null}
        {reassure ? (
          <p className="text-xs text-fg-muted">
            {demo
              ? "Your file is private to this browser, is not shared with anyone, and is deleted after a day."
              : "Your files stay on this machine and never leave it."}
          </p>
        ) : null}
        {invalid ? (
          <div id={`${id}-err`} className="flex flex-col text-xs text-danger">
            {errors!.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={fileRef}
          id={`${id}-file`}
          type="file"
          accept=".pdf,application/pdf"
          className="sr-only"
          aria-label="Upload a file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button variant="outline" size="sm" disabled={Boolean(upload && !upload.error)} onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden strokeWidth={1.75} />
          Upload
        </Button>
        {upload && !upload.error ? (
          <span role="status" className="truncate text-xs text-fg-muted">
            Uploading {upload.name}
          </span>
        ) : null}
      </div>
      {showLimits ? (
        <p className="text-xs text-fg-muted" data-testid="upload-limits">
          {limits ? `PDF only, up to ${mb} MB and ${limits.max_pages} pages.` : "PDF only."}
        </p>
      ) : null}
      {upload?.error ? (
        <p role="alert" className="text-xs text-danger">
          Upload of {upload.name} failed: {upload.error}
        </p>
      ) : null}
    </div>
  )
}
