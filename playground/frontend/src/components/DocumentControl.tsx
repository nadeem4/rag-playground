import { useEffect, useRef, useState } from "react"
import { Check, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu } from "radix-ui"

import { api, ApiError } from "@/api/client"
import type { SampleCard } from "@/api/types"
import { useDemo } from "@/api/useDemo"
import {
  chooseDocument,
  documentBusy,
  loadSampleDocument,
  refreshUploads,
  setDocumentMenuOpen,
  takeDocumentMenuOpener,
  useDocStatus,
  useDocument,
  type DocRef,
} from "@/state/document"

import { hostOf } from "./DocumentItem"
import { useUpload } from "./useUpload"

const reason = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

/** One choice in the menu: a name, a quiet second line, and a tick when it is the document. */
const ITEM =
  "grid min-h-[44px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-control p-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-hover data-[state=checked]:bg-accent-wash data-[disabled]:opacity-50"

const HEADING = "px-2 pt-2 pb-1 text-2xs text-fg-muted"

/**
 * The Document control: a link that opens a menu to change the document (the
 * samples, this browser's uploads, Upload a document and a link box). It sits beside the
 * Document element that names the document: in Build's Document step ("Add or
 * change"), under Evaluate's Documents, and on Compare's Document line. When
 * the saved upload is gone its name says so, and the menu opens on a warning.
 * While the lists load it reads as ready, never missing. Its open state is the
 * store's, so a page's "Pick a document" button opens it too; one page shows
 * one control.
 *
 * By default a pick becomes the working pipeline's document. A page that keeps
 * its own document (Evaluate, trying a pipeline on another file) passes
 * `value` and `onChoose`, and the pipeline on Build stays as it is.
 */
export function DocumentControl({
  label = "Change",
  value,
  onChoose,
  foot,
}: {
  /** The link's words, such as "Add or change" on Build. */
  label?: string
  /** The document this page uses, when it is not the working pipeline's. */
  value?: DocRef | null
  /** Where a picked document goes, instead of the working pipeline. */
  onChoose?: (doc: DocRef) => Promise<void> | void
  /** The menu's first foot line, instead of the default. */
  foot?: string
} = {}) {
  const store = useDocument()
  const { samples, uploads, listError, menuOpen, sampleLoading, recoveredNote } = store
  const own = value !== undefined
  const doc = own ? value : store.doc
  const ownStatus = useDocStatus(value ?? null)
  const status = own ? ownStatus : store.status
  const demo = useDemo()
  const { upload, addLink, busy, error: uploadError, limitsLine, linkLine, accept } = useUpload()
  const fileRef = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState("")
  const [loading, setLoading] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  const missing = status === "missing"
  // While an upload, a sample or a pick is in flight, every other choice waits, so two cannot race.
  const waiting = loading !== null || busy !== null || sampleLoading !== null
  const empty = !doc
  const name = busy
    ? `Uploading ${busy}`
    : missing
      ? `Document ${doc?.filename} is missing. Pick another or upload it again.`
      : empty
        ? "Pick a document"
        : `${label} the document. Now ${doc.filename}.`
  // Nothing is ticked while the file is missing: the menu is there to pick another.
  const current = !missing && doc ? doc.sha : ""

  async function pick(key: string, run: () => Promise<void>) {
    if (documentBusy()) return
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

  /** A picked document: to the page that keeps its own, else to the working pipeline. */
  const use = (d: DocRef) => (onChoose ? Promise.resolve(onChoose(d)).then(() => setDocumentMenuOpen(false)) : chooseDocument(d))

  function pickSample(card: SampleCard) {
    void pick(card.sha, async () => {
      try {
        if (onChoose) {
          // Make sure the server has the sample, then hand it to the page.
          const src = await api.sampleSource(card.name)
          await use({ sha: src.sha, filename: src.filename })
        } else await loadSampleDocument(card)
      } catch (err) {
        throw new Error(`${card.title}: ${reason(err)}`)
      }
    })
  }

  const error = uploadError ?? pickError
  const errorRef = useRef<HTMLParagraphElement>(null)
  // The menu scrolls: a refusal under the link box is brought into view.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [error])

  return (
    <>
      {/* Outside the menu, so a file chosen after the menu closes still arrives. */}
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload a document file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          void upload(file, onChoose ? use : undefined)
        }}
      />
      <DropdownMenu.Root open={menuOpen} onOpenChange={setDocumentMenuOpen}>
        <DropdownMenu.Trigger
          data-testid="document-trigger"
          aria-label={name}
          title={name}
          aria-busy={busy ? true : undefined}
          className="inline-flex min-h-[1.5rem] items-center text-sm font-semibold text-primary underline underline-offset-4 outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
        >
          {busy ? `Uploading ${busy}` : empty ? "Pick a document" : label}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={16}
            onCloseAutoFocus={(e) => {
              // Opened from a page's button: focus goes back there, not to this trigger.
              const back = takeDocumentMenuOpener()
              if (back?.isConnected) {
                e.preventDefault()
                back.focus()
              }
            }}
            className="menu-drop z-50 flex max-h-[min(560px,calc(100dvh-96px))] w-[min(360px,calc(100vw-32px))] flex-col gap-1 overflow-y-auto rounded-panel border border-hairline bg-surface-raised p-2 text-fg shadow-sheet"
          >
            {missing ? (
              <p role="status" className="rounded-control bg-stale-wash p-2 text-xs text-stale">
                {doc?.filename} is no longer on {demo ? "the demo" : "this machine"}. Upload it again, or pick a sample.
              </p>
            ) : recoveredNote ? (
              <p role="status" className="rounded-control bg-surface-hover p-2 text-xs text-fg-muted">
                {recoveredNote}
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
                      disabled={waiting}
                      aria-busy={sampleLoading === s.name ? true : undefined}
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
                      <span className="col-start-1 min-w-0 truncate text-xs text-fg-muted">{sampleLoading === s.name ? "Loading this sample." : s.blurb}</span>
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
                    disabled={waiting}
                    className={ITEM}
                    onSelect={(e) => {
                      e.preventDefault()
                      if (u.sha !== current) void pick(u.sha, () => use({ sha: u.sha, filename: u.filename }))
                      else setDocumentMenuOpen(false)
                    }}
                  >
                    {/* A link reads as its host, so the long name made from its path stays out of the way. */}
                    <span className="min-w-0 truncate" title={u.origin_url ? u.filename : undefined}>
                      {u.origin_url ? hostOf(u.origin_url) : u.filename}
                    </span>
                    <DropdownMenu.ItemIndicator className="row-span-2 text-primary">
                      <Check aria-hidden strokeWidth={2} className="size-4" />
                    </DropdownMenu.ItemIndicator>
                    <span className="col-start-1 text-2xs text-fg-muted">
                      {u.origin_url ? "From a link, " : null}
                      <span className="font-mono">{Math.max(1, Math.round(u.size / 1024))} KB</span>
                    </span>
                  </DropdownMenu.RadioItem>
                ))
              )}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Item
              disabled={waiting}
              className="mt-1 flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-control border border-dashed border-hairline p-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50"
              onSelect={(e) => {
                // Stay open: the upload's progress and any refusal show here.
                e.preventDefault()
                fileRef.current?.click()
              }}
            >
              <Upload aria-hidden strokeWidth={1.75} className="size-4" />
              {busy ? `Uploading ${busy}` : "Upload a document"}
            </DropdownMenu.Item>
            <p className={HEADING}>Or add a link</p>
            <form
              noValidate
              className="flex gap-2 px-2"
              onSubmit={(e) => {
                e.preventDefault()
                void addLink(link, onChoose ? use : undefined).then((ok) => ok && setLink(""))
              }}
            >
              <input
                type="url"
                value={link}
                placeholder="https://example.com/guide.html"
                aria-label="Link to a web page or PDF"
                disabled={waiting}
                className="min-h-[36px] min-w-0 flex-1 rounded-control border border-field-border bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
                onChange={(e) => setLink(e.target.value)}
                // The menu jumps to an item by its first letter: typing here stays in the box.
                onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
              />
              <Button type="submit" size="sm" disabled={waiting || !link.trim()}>
                Add
              </Button>
            </form>
            {error ? (
              <p ref={errorRef} role="alert" className="px-2 text-xs text-danger">
                {error}
              </p>
            ) : null}
            <p className="px-2 pt-1 text-2xs text-fg-muted">
              {foot ?? "The pipeline runs on this document."}{" "}
              {demo ? "Uploads on the demo are private to this browser and expire." : "Your files stay on this machine."}
            </p>
            <p className="px-2 text-2xs text-fg-muted" data-testid="upload-limits">
              {limitsLine}
            </p>
            <p className="px-2 pb-1 text-2xs text-fg-muted">{linkLine}</p>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}
