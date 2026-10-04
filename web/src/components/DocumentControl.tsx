import { useRef, useState } from "react"
import { Check, ChevronDown, FileText, Upload } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { ApiError } from "@/api/client"
import type { SampleCard } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import { cn } from "@/lib/utils"
import { chooseDocument, loadSampleDocument, refreshUploads, setDocumentMenuOpen, useDocument } from "@/state/document"

import { useUpload } from "./useUpload"

const reason = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

/** One choice in the menu: a name, a quiet second line, and a tick when it is the document. */
const ITEM =
  "grid min-h-[44px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-control p-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-hover data-[state=checked]:bg-accent-wash data-[disabled]:opacity-50"

const HEADING = "px-2 pt-2 pb-1 text-2xs text-fg-muted"

/**
 * The Document control in the header: which document every page uses, and a
 * menu to change it (the samples, this browser's uploads and Upload a PDF).
 * When the saved upload is gone it turns amber and reads Missing. While the
 * lists load it looks ready, never amber. Its open state is the store's, so a
 * page's "Pick a document" button opens it too.
 */
export function DocumentControl() {
  const { doc, status, samples, uploads, listError, menuOpen } = useDocument()
  const demo = useDemo()
  const { upload, busy, error: uploadError, limitsLine } = useUpload()
  const fileRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  const missing = status === "missing"
  const empty = !doc
  const name = busy ? `Uploading ${busy}` : empty ? "Pick a document" : doc.filename
  const label = busy ? `Uploading ${busy}` : missing ? `Document ${doc?.filename} is missing. Pick another or upload it again.` : empty ? "Pick a document" : `Document: ${doc.filename}. Change it.`
  // Nothing is ticked while the file is missing: the menu is there to pick another.
  const current = !missing && doc ? doc.sha : ""

  async function pick(key: string, run: () => Promise<void>) {
    setPickError(null)
    setLoading(key)
    try {
      await run()
    } catch (err) {
      setPickError(`Could not use that document: ${reason(err)}`)
    } finally {
      setLoading(null)
    }
  }

  function pickSample(card: SampleCard) {
    void pick(card.sha, async () => {
      try {
        await loadSampleDocument(card)
      } catch (err) {
        throw new Error(`${card.title}: ${reason(err)}`)
      }
    })
  }

  const error = uploadError ?? pickError

  return (
    <>
      {/* Outside the menu, so a file chosen after the menu closes still arrives. */}
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
      <DropdownMenu.Root open={menuOpen} onOpenChange={setDocumentMenuOpen}>
        <DropdownMenu.Trigger
          data-testid="document-trigger"
          aria-label={label}
          aria-busy={busy ? true : undefined}
          className={cn(
            "flex h-row w-full min-w-0 items-center gap-2 rounded-control border px-2 text-left text-sm md:w-auto md:max-w-[360px]",
            missing
              ? "border-stale bg-stale-wash text-stale hover:bg-stale-wash"
              : "border-hairline bg-surface-raised text-fg hover:bg-surface-hover",
          )}
        >
          <FileText aria-hidden strokeWidth={1.75} className="size-[18px] shrink-0" />
          <span className={cn("hidden shrink-0 text-2xs whitespace-nowrap md:inline", missing ? "text-stale" : "text-fg-muted")}>
            {missing ? "Missing" : "Document"}
          </span>
          <span className={cn("min-w-0 flex-1 truncate", empty && !busy ? "font-normal text-fg-muted" : "font-semibold")}>{name}</span>
          <ChevronDown aria-hidden strokeWidth={1.75} className={cn("size-[18px] shrink-0", missing ? "text-stale" : "text-fg-muted")} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            collisionPadding={16}
            className="menu-drop z-10 flex max-h-[min(560px,calc(100dvh-96px))] w-[min(360px,calc(100vw-32px))] flex-col gap-1 overflow-y-auto rounded-panel border border-hairline bg-surface-raised p-2 text-fg shadow-sheet"
          >
            {missing ? (
              <p role="status" className="rounded-control bg-stale-wash p-2 text-xs text-stale">
                {doc?.filename} is no longer on the server. Uploads on the demo expire. Upload it again, or pick a sample.
              </p>
            ) : null}
            <DropdownMenu.RadioGroup value={current}>
              {samples?.length ? (
                <>
                  <DropdownMenu.Label className={HEADING}>Samples</DropdownMenu.Label>
                  {samples.map((s) => (
                    <DropdownMenu.RadioItem
                      key={s.name}
                      value={s.sha}
                      disabled={loading !== null}
                      aria-busy={loading === s.sha ? true : undefined}
                      className={ITEM}
                      onSelect={(e) => {
                        e.preventDefault()
                        if (s.sha !== current) pickSample(s)
                        else setDocumentMenuOpen(false)
                      }}
                    >
                      <span className="min-w-0 truncate">{s.title}</span>
                      <DropdownMenu.ItemIndicator className="row-span-2 text-primary">
                        <Check aria-hidden strokeWidth={2} className="size-4" />
                      </DropdownMenu.ItemIndicator>
                      <span className="col-start-1 min-w-0 truncate text-xs text-fg-muted">{loading === s.sha ? "Loading this sample." : s.blurb}</span>
                    </DropdownMenu.RadioItem>
                  ))}
                  <DropdownMenu.Separator className="my-1 h-[1px] bg-hairline" />
                </>
              ) : null}
              <DropdownMenu.Label className={HEADING}>Your uploads</DropdownMenu.Label>
              {listError ? (
                <>
                  <p className="px-2 pb-1 text-xs text-fg-muted">Could not list your uploads.</p>
                  <DropdownMenu.Item
                    className={ITEM}
                    onSelect={(e) => {
                      e.preventDefault()
                      refreshUploads()
                    }}
                  >
                    Retry
                  </DropdownMenu.Item>
                </>
              ) : uploads === null ? (
                <p className="px-2 pb-1 text-xs text-fg-muted">Loading your uploads.</p>
              ) : uploads.length === 0 ? (
                <p className="px-2 pb-1 text-xs text-fg-muted">None in this browser yet.</p>
              ) : (
                uploads.map((u) => (
                  <DropdownMenu.RadioItem
                    key={u.sha}
                    value={u.sha}
                    disabled={loading !== null}
                    className={ITEM}
                    onSelect={(e) => {
                      e.preventDefault()
                      if (u.sha !== current) void pick(u.sha, () => chooseDocument({ sha: u.sha, filename: u.filename }))
                      else setDocumentMenuOpen(false)
                    }}
                  >
                    <span className="min-w-0 truncate">{u.filename}</span>
                    <DropdownMenu.ItemIndicator className="row-span-2 text-primary">
                      <Check aria-hidden strokeWidth={2} className="size-4" />
                    </DropdownMenu.ItemIndicator>
                    <span className="col-start-1 font-mono text-2xs text-fg-muted">{Math.max(1, Math.round(u.size / 1024))} KB</span>
                  </DropdownMenu.RadioItem>
                ))
              )}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Item
              disabled={busy !== null}
              className="mt-1 flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-control border border-dashed border-hairline p-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50"
              onSelect={(e) => {
                // Stay open: the upload's progress and any refusal show here.
                e.preventDefault()
                fileRef.current?.click()
              }}
            >
              <Upload aria-hidden strokeWidth={1.75} className="size-4" />
              {busy ? `Uploading ${busy}` : "Upload a PDF"}
            </DropdownMenu.Item>
            {error ? (
              <p role="alert" className="px-2 text-xs text-danger">
                {error}
              </p>
            ) : null}
            <p className="px-2 pt-1 text-2xs text-fg-muted">
              {demo
                ? "Every page uses this document. Uploads on the demo are private to this browser and expire."
                : "Every page uses this document. Your files stay on this machine."}
            </p>
            <p className="px-2 pb-1 text-2xs text-fg-muted" data-testid="upload-limits">
              {limitsLine}
            </p>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}
