import { useEffect, useState } from "react"

import { api } from "./client"
import type { SampleCard, SampleQuestion, Source } from "./types"

/**
 * The bundled samples, for the first-visit card (`FirstRun`) and the Ask
 * panel. The Document control's store (state/document.ts) keeps its own copy,
 * fetched once per page.
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
 * The question set of the sample called `name`. No name (an upload, or a file
 * no sample has) gets none. The caller finds the sample, so the list is not
 * fetched twice.
 */
export function useSampleQuestions(name: string | undefined): SampleQuestion[] {
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
