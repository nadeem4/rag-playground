import { useCallback, useEffect, useState } from "react"

import { clearTabSet, readTabSet, report, storeTabSet, type Report } from "@/state/goldSet"

import { ApiError, api } from "./client"
import type { StoredQuestionSet } from "./types"

/**
 * The question set stored against the document on Build (plan I-31).
 *
 * The server keeps it under the document's fingerprint. A hosted demo will not
 * keep it at all, and says so by sending `stored: false` or by refusing the
 * request outright, so an uploaded set falls back to this browser tab.
 */

export interface QuestionSetState {
  set: StoredQuestionSet | null
  /** Still asking the server what it has. */
  loading: boolean
  /** The last upload's check. It stays until the set is replaced or removed. */
  report: Report | null
  /** The server would not keep this set, so it lives in this browser tab. */
  tabOnly: boolean
  error: string | null
  /** An upload or a removal is in flight. */
  busy: boolean
  upload: (file: File) => Promise<void>
  remove: () => Promise<void>
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const DEMO_REFUSED = "This hosted demo does not store question sets. Run the playground locally to evaluate your own document."

export function useQuestionSet(sourceSha: string): QuestionSetState {
  const [set, setSet] = useState<StoredQuestionSet | null>(null)
  const [loading, setLoading] = useState(true)
  const [rep, setRep] = useState<Report | null>(null)
  const [tabOnly, setTabOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setSet(null)
    setRep(null)
    setTabOnly(false)
    api.questionSet(sourceSha).then(
      (s) => {
        if (!live) return
        setSet(s)
        setLoading(false)
      },
      () => {
        // No set on the server, or no route yet: this tab may still hold one.
        if (!live) return
        const held = readTabSet(sourceSha)
        setSet(held)
        setTabOnly(held !== null)
        setLoading(false)
      },
    )
    return () => {
      live = false
    }
  }, [sourceSha])

  const upload = useCallback(
    async (file: File) => {
      setBusy(true)
      setError(null)
      try {
        const s = await api.uploadQuestionSet(sourceSha, file)
        const kept = s.stored !== false
        if (!kept) storeTabSet(s)
        setSet(s)
        setTabOnly(!kept)
        setRep(report(s))
      } catch (err) {
        setError(err instanceof ApiError && err.status === 403 ? DEMO_REFUSED : message(err))
      } finally {
        setBusy(false)
      }
    },
    [sourceSha],
  )

  const remove = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteQuestionSet(sourceSha)
    } catch {
      // Nothing on the server to delete, which is the state we wanted anyway.
    }
    clearTabSet()
    setSet(null)
    setTabOnly(false)
    setRep(null)
    setBusy(false)
  }, [sourceSha])

  return { set, loading, report: rep, tabOnly, error, busy, upload, remove }
}
