import { useEffect, useState } from "react"

import { questionsFromSamples, questionsFromSet, sampleFor, uniqueIds, type Question } from "@/state/goldSet"
import type { DocRef } from "@/state/sourceDocs"
import { forDocument } from "@/state/takeHome"

import { api } from "./client"
import type { SampleCard } from "./types"
import { useQuestionSet } from "./useQuestionSet"
import { useQuestionSetAcross } from "./useQuestionSetAcross"

/**
 * Every question a pipeline's documents have, each naming its document by sha,
 * for the Take it home page. One document reads its own stored set (Evaluate
 * writes it there, or into this tab on the demo) and tags it with that
 * document. Several documents read the set across them. A bundled sample among
 * the documents always lends its own questions, so a kept set elsewhere does
 * not hide them; `sampleShas` says which documents are samples.
 */
export function useTakeHomeQuestions(docs: readonly DocRef[], samples: SampleCard[] | null): { questions: Question[] | null; sampleShas: string[] } {
  const shas = docs.map((d) => d.sha)
  const one = shas.length === 1 ? shas[0] : ""
  const single = useQuestionSet(one)
  const across = useQuestionSetAcross(shas.length > 1 ? shas : [], samples)

  // `sha:name` pairs of the samples among the documents.
  const pairs = shas.flatMap((sha) => {
    const s = sampleFor(sha, samples)
    return s ? [`${sha}:${s.name}`] : []
  })
  const pairKey = pairs.join(",")
  const [sampleQs, setSampleQs] = useState<Question[] | null>(null)
  useEffect(() => {
    if (samples === null) return setSampleQs(null)
    if (!pairKey) return setSampleQs([])
    let live = true
    const list = pairKey.split(",").map((p) => p.split(":") as [string, string])
    Promise.all(list.map(([sha, name]) => api.sampleQuestions(name).then((questions) => ({ sha, questions })))).then(
      (sets) => live && setSampleQs(questionsFromSamples(sets)),
      () => live && setSampleQs([]),
    )
    return () => {
      live = false
    }
  }, [pairKey, samples])

  const sampleShas = pairs.map((p) => p.split(":")[0])
  let kept: Question[] | null
  if (shas.length === 1) kept = single.loading ? null : single.set ? forDocument(questionsFromSet(single.set), shas[0]) : []
  else kept = across.questions === null ? null : across.fromSamples ? [] : across.questions
  if (kept === null || sampleQs === null) return { questions: null, sampleShas }

  // A sample's own questions fill in only for a sample document with none kept.
  const named = new Set(kept.map((q) => q.document))
  const lent = sampleQs.filter((q) => !named.has(q.document))
  return { questions: uniqueIds([...kept, ...lent]), sampleShas }
}
