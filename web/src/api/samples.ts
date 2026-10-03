import { useEffect, useState } from "react"

import { api } from "./client"
import type { SampleCard, SampleQuestion, Source } from "./types"

/**
 * The bundled samples, shared by every place that lists or loads one (F2):
 * the Load card (`FirstRun`) and the file picker's Samples group
 * (`SourcePicker`). One fetch, one error message, instead of three.
 */
export interface SamplesState {
  /** Null until the list arrives, or when it could not be read. */
  samples: SampleCard[] | null
  /** Set when the list could not be read, so a caller need not stay silent. */
  error: string | null
}

export function useSamples(): SamplesState {
  const [state, setState] = useState<SamplesState>({ samples: null, error: null })
  useEffect(() => {
    let live = true
    api.samples().then(
      (s) => live && setState({ samples: s, error: null }),
      (err: unknown) => live && setState({ samples: null, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [])
  return state
}

/** `POST /api/sources/sample`: load one bundled sample by name. */
export function loadSample(name: string): Promise<Source> {
  return api.sampleSource(name)
}

/** Question sets by sample name, fetched once per session. A failed fetch is not kept. */
const questionCache = new Map<string, Promise<SampleQuestion[]>>()

/** Tests only: forget the cached question sets. */
export function resetSampleQuestionsCache(): void {
  questionCache.clear()
}

function loadQuestions(name: string): Promise<SampleQuestion[]> {
  let p = questionCache.get(name)
  if (!p) {
    p = api.sampleQuestions(name)
    p.catch(() => questionCache.delete(name))
    questionCache.set(name, p)
  }
  return p
}

/**
 * The question set of the sample whose file is `sha`. An upload, or a sha no
 * sample has, gets none.
 */
export function useSampleQuestions(sha: string | undefined): SampleQuestion[] {
  const { samples } = useSamples()
  const name = sha ? samples?.find((s) => s.sha === sha)?.name : undefined
  const [state, setState] = useState<{ name?: string; questions: SampleQuestion[] }>({ questions: [] })
  useEffect(() => {
    if (!name) return
    let live = true
    loadQuestions(name).then(
      (questions) => live && setState({ name, questions: Array.isArray(questions) ? questions : [] }),
      () => live && setState({ name, questions: [] }),
    )
    return () => {
      live = false
    }
  }, [name])
  return name && state.name === name ? state.questions : []
}
