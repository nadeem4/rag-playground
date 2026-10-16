import { useEffect, useState } from "react"

import { ApiError } from "@/api/client"
import { v2 } from "@/api/v2"
import { useAppSettings } from "@/api/useDemo"
import { loadRegistry } from "@/api/useRegistry"
import { acceptFor, FORMATS, formatOf, formatsLine, readableFormats } from "@/lib/formats"
import { chooseDocument, documentBusy, refreshUploads, setUploadState, useDocument, type DocRef } from "@/state/document"

/** The server's own sentence when it sent one, so a visitor reads why without the status and path in front. */
const reason = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

const ALL = Object.keys(FORMATS)
let formatsOnce: Promise<string[]> | null = null

/** The formats this server's parsers read, from the registry. Every known one until it answers, or if it fails: the server still checks. */
function useReadableFormats(): string[] {
  const [formats, setFormats] = useState<string[]>(ALL)
  useEffect(() => {
    let live = true
    formatsOnce ??= loadRegistry().then(
      (r) => (readableFormats(r).length ? readableFormats(r) : ALL),
      () => {
        formatsOnce = null // asked again on the next mount
        return ALL
      },
    )
    formatsOnce.then((f) => live && setFormats(f))
    return () => {
      live = false
    }
  }, [])
  return formats
}

export interface Upload {
  /**
   * Check and send a file; a finished upload becomes the document, or goes to
   * `use` when a page keeps its own (Evaluate trying a pipeline on it). True when it did.
   */
  upload: (file: File | undefined, use?: (doc: DocRef) => Promise<void> | void) => Promise<boolean>
  /** Fetch a page from a link once (`POST /api/v2/documents/url`) and use it like an upload. True when it did. */
  addLink: (url: string, use?: (doc: DocRef) => Promise<void> | void) => Promise<boolean>
  /** What is on its way, as its label ("Uploading notes.docx", "Fetching example.com"), or null. */
  busy: string | null
  /** The sentence to show when an upload or a link was refused or failed, or null. */
  error: string | null
  /** The formats and, on the demo, the PDF limits: "PDF, Word, ... or images. A PDF up to N MB and P pages." */
  limitsLine: string
  /** What a link does, and on the demo which ones work. */
  linkLine: string
  /** The file input's `accept`: every extension a parser reads. */
  accept: string
}

/**
 * Upload a document (`POST /api/v2/documents`) or add one from a link
 * (`POST /api/v2/documents/url`), shared by the Document control's menu,
 * Build's first-visit card and Home. Three checks: a format some parser reads,
 * the demo's size limit for that kind of file, and the server's own sentence
 * when it refuses. The busy file and the error live in the document store, so
 * every caller (and the Document control's trigger) shows the same one, and a second
 * upload or a sample cannot start while one runs.
 */
export function useUpload(): Upload {
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = demo ? settings.limits : undefined
  const formats = useReadableFormats()
  const { uploading: busy, uploadError: error } = useDocument()
  const line = formatsLine(formats)

  async function send(label: string, call: () => Promise<{ sha: string; filename: string }>, use: (doc: DocRef) => Promise<void> | void, fail: (why: string) => string) {
    setUploadState({ uploading: label, uploadError: null })
    try {
      const src = await call()
      refreshUploads()
      await use({ sha: src.sha, filename: src.filename })
      return true
    } catch (err) {
      setUploadState({ uploadError: fail(reason(err)) })
      return false
    } finally {
      setUploadState({ uploading: null })
    }
  }

  async function upload(file: File | undefined, use: (doc: DocRef) => Promise<void> | void = chooseDocument) {
    if (!file || documentBusy()) return false
    const refuse = (why: string) => {
      setUploadState({ uploadError: `Upload of ${file.name} failed: ${why}` })
      return false
    }
    const kind = formatOf(file.name) ?? (file.type === "application/pdf" ? "pdf" : null)
    if (!kind || !formats.includes(kind)) return refuse(`This kind of file cannot be read here. Upload ${line}.`)
    const cap = !limits
      ? null
      : kind === "pdf"
        ? limits.max_bytes
        : kind === "png" || kind === "jpg"
          ? (limits.max_image_bytes ?? null)
          : (limits.max_other_bytes ?? null)
    if (cap !== null && file.size > cap) {
      const mb = Math.round(cap / 1048576)
      return refuse(
        kind === "pdf"
          ? `This file is ${(file.size / 1048576).toFixed(1)} MB. The hosted demo takes files up to ${mb} MB. Or split out the pages you need and upload those.`
          : `This file is ${(file.size / 1048576).toFixed(1)} MB. The hosted demo takes ${kind === "png" || kind === "jpg" ? "images" : `${FORMATS[kind].label} files`} up to ${mb} MB.`,
      )
    }
    return send(`Uploading ${file.name}`, () => v2.uploadDocument(file), use, (why) => `Upload of ${file.name} failed: ${why}`)
  }

  async function addLink(text: string, use: (doc: DocRef) => Promise<void> | void = chooseDocument) {
    if (documentBusy()) return false
    const url = text.trim()
    let host = ""
    try {
      const u = new URL(url)
      if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname
    } catch {
      // Not a link: said below.
    }
    if (!host) {
      setUploadState({ uploadError: "That is not a link. Paste one that starts with https://" })
      return false
    }
    return send(`Fetching ${host}`, () => v2.addLink(url), use, (why) => why)
  }

  const parts: string[] = []
  if (limits) parts.push(`A PDF up to ${Math.round(limits.max_bytes / 1048576)} MB and ${limits.max_pages} pages.`)
  if (limits?.max_other_bytes && formats.some((f) => !["pdf", "png", "jpg"].includes(f))) {
    parts.push(`Other files up to ${Math.round(limits.max_other_bytes / 1048576)} MB.`)
  }
  if (limits?.max_image_bytes && formats.some((f) => f === "png" || f === "jpg")) {
    parts.push(`Images up to ${Math.round(limits.max_image_bytes / 1048576)} MB.`)
  }
  return {
    upload,
    addLink,
    busy,
    error,
    limitsLine: [`${line}.`, ...parts].join(" "),
    linkLine: demo ? "A link is fetched once and kept like an upload. Only public web addresses work." : "A link is fetched once and kept like an upload.",
    accept: acceptFor(formats),
  }
}
