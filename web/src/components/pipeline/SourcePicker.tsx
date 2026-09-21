import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Upload } from "lucide-react"

import { api } from "@/api/client"
import type { Source } from "@/api/types"
import { Button } from "@/components/ui/button"
import { CONTROL } from "@/components/fields/types"

/**
 * The Load card's body: upload a file (`POST /api/sources`) or pick one
 * already uploaded (`GET /api/sources`). Emits the source node's config,
 * `{sha, filename}`.
 */

export interface SourceConfig {
  sha?: string
  filename?: string
}

type ListState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: Source[] }

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export function SourcePicker({
  value,
  onChange,
  errors,
}: {
  value: SourceConfig
  onChange: (v: SourceConfig) => void
  errors?: string[]
}) {
  const id = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [list, setList] = useState<ListState>({ kind: "loading" })
  const [upload, setUpload] = useState<{ name: string; error?: string } | null>(null)

  const refresh = useCallback(() => {
    api.sources().then(
      (items) => setList({ kind: "ready", items }),
      (err: unknown) => setList({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    )
  }, [])

  useEffect(refresh, [refresh])

  async function onFile(file: File | undefined) {
    if (!file) return
    setUpload({ name: file.name })
    try {
      const src = await api.uploadSource(file)
      setUpload(null)
      onChange({ sha: src.sha, filename: src.filename })
      refresh()
    } catch (err) {
      setUpload({ name: file.name, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const items = list.kind === "ready" ? list.items : []
  const current = items.find((s) => s.sha === value.sha)
  const invalid = Boolean(errors?.length)

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
        ) : items.length === 0 ? (
          <p className="text-sm text-fg-muted">No files uploaded yet. Upload a PDF to start.</p>
        ) : (
          <select
            id={`${id}-pick`}
            className={CONTROL}
            value={current ? current.sha : ""}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-err` : undefined}
            onChange={(e) => {
              const s = items.find((x) => x.sha === e.target.value)
              if (s) onChange({ sha: s.sha, filename: s.filename })
            }}
          >
            {current ? null : (
              <option value="" disabled>
                {value.filename ? `${value.filename} (missing)` : "None selected"}
              </option>
            )}
            {items.map((s) => (
              <option key={s.sha} value={s.sha}>
                {s.filename}
              </option>
            ))}
          </select>
        )}
        {current ? (
          <p className="font-mono text-xs text-fg-muted">
            {fmtBytes(current.size)} <span className="px-1">sha</span>
            {current.sha.slice(0, 12)}
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
      {upload?.error ? (
        <p role="alert" className="text-xs text-danger">
          Upload of {upload.name} failed: {upload.error}
        </p>
      ) : null}
    </div>
  )
}
