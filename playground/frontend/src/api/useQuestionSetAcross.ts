import { useCallback, useEffect, useState } from "react"

import {
  questionsFromAcross,
  questionsFromChecks,
  questionsFromSamples,
  questionsFromSet,
  readTabAcross,
  report,
  sampleFor,
  storeTabAcross,
  type Question,
  type Report,
} from "@/state/goldSet"

import { api, ApiError, plainMessage } from "./client"
import type { SampleCard } from "./types"
import { v2 } from "./v2"

/**
 * One question set for a pipeline with several documents (spec "Evaluate
 * (part 4a)"). The server keeps it split by document and hands it back as one
 * (`GET /api/v2/questions?documents=...`), each question naming its document
 * by sha, or none. An upload goes through `POST /api/v2/questions` and
 * replaces the whole set. With nothing kept, the bundled samples among the
 * documents lend their own sets, each question naming its sample. A hosted
 * demo keeps nothing, so an upload lives in this browser tab.
 *
 * `shas` empty means one document: nothing is asked, and `useQuestionSet`
 * does the work as before.
 */

export interface QuestionSetAcrossState {
  /** Null while it is being read. */
  questions: Question[] | null
  /** The files the set was read from; empty for the samples' sets. */
  filenames: string[]
  /** The questions are the samples' own sets. */
  fromSamples: boolean
  report: Report | null
  tabOnly: boolean
  error: string | null
  busy: boolean
  /** Replace the set with this file, for every document. True when it was taken. */
  upload: (file: File) => Promise<boolean>
  /** Save a set written for the first document (Write questions for me), as that sheet does today. */
  saveWritten: (file: File) => Promise<boolean>
}

const DEMO_REFUSED = "This hosted demo does not store question sets. Run the playground locally to evaluate your own document."

export function useQuestionSetAcross(shas: readonly string[], samples: SampleCard[] | null): QuestionSetAcrossState {
  const key = shas.join(",")
  const [kept, setKept] = useState<{ questions: Question[]; filenames: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [sampleQs, setSampleQs] = useState<Question[] | null>(null)
  const [rep, setRep] = useState<Report | null>(null)
  const [tabOnly, setTabOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reads, setReads] = useState(0)

  useEffect(() => {
    if (!key) return
    let live = true
    setLoading(true)
    const list = key.split(",")
    const fromTab = () => {
      if (!live) return
      const held = readTabAcross(list)
      setKept(held ? { questions: held.questions, filenames: [held.filename] } : null)
      setTabOnly(held !== null)
      setLoading(false)
    }
    v2.questionSetAcross(list).then((s) => {
      if (!live) return
      if (!s.questions.length) return fromTab()
      setKept({ questions: questionsFromAcross(s), filenames: s.filenames ?? [] })
      setTabOnly(false)
      setLoading(false)
    }, fromTab)
    return () => {
      live = false
    }
  }, [key, reads])

  // The samples among the documents, each lending its own set: `sha:name` pairs.
  const sampledKey = (key ? key.split(",") : [])
    .flatMap((sha) => {
      const s = sampleFor(sha, samples)
      return s ? [`${sha}:${s.name}`] : []
    })
    .join(",")
  useEffect(() => {
    if (!sampledKey) {
      setSampleQs(samples === null ? null : [])
      return
    }
    let live = true
    const pairs = sampledKey.split(",").map((p) => p.split(":") as [string, string])
    Promise.all(pairs.map(([sha, name]) => api.sampleQuestions(name).then((questions) => ({ sha, questions })))).then(
      (sets) => live && setSampleQs(questionsFromSamples(sets)),
      () => live && setSampleQs([]),
    )
    return () => {
      live = false
    }
  }, [sampledKey, samples])

  const upload = useCallback(
    async (file: File): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const list = key.split(",")
        const s = await v2.uploadQuestionSetAcross(list, file)
        setRep(report(s))
        if (s.stored === false) {
          const questions = questionsFromChecks(s.questions)
          storeTabAcross(list, s.filename, questions)
          setKept({ questions, filenames: [s.filename] })
          setTabOnly(true)
        } else setReads((n) => n + 1)
        return true
      } catch (err) {
        setError(err instanceof ApiError && err.status === 403 ? DEMO_REFUSED : plainMessage(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [key],
  )

  const saveWritten = useCallback(
    async (file: File): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const list = key.split(",")
        const first = list[0]
        const s = await v2.uploadQuestionSet(first, file)
        setRep(report(s))
        if (s.stored === false) {
          // As the server would keep it: the first document's set is replaced, the rest stay.
          const written = questionsFromSet(s).map((q) => ({ ...q, document: first }))
          const rest = (kept?.questions ?? []).filter((q) => q.document !== first)
          const questions = [...rest, ...written]
          storeTabAcross(list, s.filename, questions)
          setKept({ questions, filenames: [...new Set([...(kept?.filenames ?? []), s.filename])] })
          setTabOnly(true)
        } else setReads((n) => n + 1)
        return true
      } catch (err) {
        setError(err instanceof ApiError && err.status === 403 ? DEMO_REFUSED : plainMessage(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [key, kept],
  )

  const fromSamples = !kept && !loading
  const questions = loading ? null : kept ? kept.questions : sampleQs
  return { questions, filenames: kept?.filenames ?? [], fromSamples, report: rep, tabOnly, error, busy, upload, saveWritten }
}
