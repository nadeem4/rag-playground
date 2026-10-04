import { useState } from "react"

import { api, ApiError } from "@/api/client"
import { useAppSettings } from "@/api/useDemo"
import { chooseDocument, refreshUploads } from "@/state/document"

/** The server's own sentence when it sent one, so a visitor reads why without the status and path in front. */
const reason = (err: unknown) =>
  err instanceof ApiError && typeof err.detail === "string" ? err.detail : err instanceof Error ? err.message : String(err)

export interface Upload {
  /** Check and send a file; a finished upload becomes the document. */
  upload: (file: File | undefined) => Promise<void>
  /** The name of the file being sent, or null. */
  busy: string | null
  /** The sentence to show when an upload was refused or failed, or null. */
  error: string | null
  /** "PDF only, up to N MB and P pages." on the demo, "PDF only." locally. */
  limitsLine: string
}

/**
 * Upload a PDF (`POST /api/sources`), shared by the Document control's menu
 * and Build's first-visit card. Three checks, in the words the upload card
 * always used: PDF only, the demo's size limit, and the server's own sentence
 * when it refuses.
 */
export function useUpload(): Upload {
  const settings = useAppSettings()
  const limits = settings?.demo === true ? settings.limits : undefined
  const mb = limits ? Math.round(limits.max_bytes / 1048576) : 0
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File | undefined) {
    if (!file) return
    const refuse = (why: string) => setError(`Upload of ${file.name} failed: ${why}`)
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
    setError(null)
    setBusy(file.name)
    try {
      const src = await api.uploadSource(file)
      refreshUploads()
      await chooseDocument({ sha: src.sha, filename: src.filename })
    } catch (err) {
      refuse(reason(err))
    } finally {
      setBusy(null)
    }
  }

  return { upload, busy, error, limitsLine: limits ? `PDF only, up to ${mb} MB and ${limits.max_pages} pages.` : "PDF only." }
}
