/**
 * Whether the "The document" panel on a lesson starts open. It is open for the
 * first lesson a viewer opens, so the document is seen once, and closed after
 * that. A viewer who opens or closes it keeps that choice. The choice lives in
 * per-viewer storage; when storage is blocked the panel simply starts open.
 */

const KEY = "rag-playground:lesson-document"

export function initialDocumentOpen(): boolean {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(KEY)
  } catch {
    return true
  }
  if (stored === "open") return true
  if (stored === "closed") return false
  // First lesson: show the document once, then start closed from now on.
  rememberDocumentOpen(false)
  return true
}

export function rememberDocumentOpen(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "open" : "closed")
  } catch {
    // Private window or blocked storage: the choice lasts for this page only.
  }
}
