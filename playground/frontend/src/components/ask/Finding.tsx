import { useEffect, useState } from "react"

import type { SampleQuestion } from "@/api/types"
import { ordinal, type HitRowData } from "@/components/inspectors/hits"
import { flatRow, isTableRow } from "@/lib/passage"
import { firstSentence } from "@/lib/sentence"

import { findGold, goldsOf } from "./Transcript"

/**
 * The finding sentence above the Ask results. A sample's own question whose
 * gold answer sits in a kept piece names that piece and quotes the answer;
 * any other question quotes the first sentence of the top kept piece, word
 * for word. With Chat the written answer stands in, so it says nothing.
 */

/**
 * Where a sample question's gold answer was found among `rows`: the piece's
 * rank and the answer it holds, null when no piece holds one, and undefined
 * while Pandion is asked.
 */
export function useGoldFound(question: string, rows: readonly HitRowData[], questions: readonly SampleQuestion[]) {
  const golds = goldsOf(question, questions)
  const key = JSON.stringify([golds, rows.map((r) => [r.rank, r.text])])
  const [result, setResult] = useState<{ key: string; found: { rank: number; gold: string } | null }>()
  useEffect(() => {
    if (!golds.length) return
    const abort = new AbortController()
    findGold(rows, golds, abort.signal).then(
      (found) => setResult({ key, found }),
      () => !abort.signal.aborted && setResult({ key, found: null }),
    )
    return () => abort.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` holds everything the request reads
  }, [key])
  if (!golds.length) return null
  return result?.key === key ? result.found : undefined
}

export interface FindingProps {
  /** The question that was asked. */
  question: string
  /** The kept pieces, in the order the reader ends with. */
  rows: readonly HitRowData[]
  /** The sample's question set; empty for an upload. */
  questions: readonly SampleQuestion[]
  /** True when Chat answered: its written answer replaces this sentence. */
  chat: boolean
}

export function Finding({ question, rows, questions, chat }: FindingProps) {
  const found = useGoldFound(question, rows, questions)
  // Until Pandion says where the gold is, say nothing rather than the wrong thing.
  if (chat || !rows.length || found === undefined) return null
  return (
    <p data-testid="finding-sentence" className="m-0 max-w-[46ch] font-sans text-lg text-balance">
      {found ? (
        <>
          {`Found in the ${ordinal(found.rank)} piece: `}
          <q className="font-serif italic" style={{ quotes: '"“" "”"' }}>
            {isTableRow(found.gold) ? flatRow(found.gold) : found.gold}
          </q>
        </>
      ) : (
        <>
          {"The closest piece says: "}
          <span className="font-serif">{firstSentence(rows[0].text)}</span>
        </>
      )}
    </p>
  )
}
