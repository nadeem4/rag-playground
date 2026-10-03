import type { SampleQuestion } from "@/api/types"
import { ordinal, type HitRowData } from "@/components/inspectors/hits"

import { goldRank } from "./Transcript"

/**
 * The finding sentence above the Ask results. A sample's own question whose
 * gold answer sits in a kept piece names that piece and quotes the answer;
 * any other question quotes the first sentence of the top kept piece, word
 * for word. With Chat the written answer stands in, so it says nothing.
 */

const MAX = 200

/** The text up to the first `.`, `?` or `!` followed by a space or the end, at most 200 characters. */
export function firstSentence(text: string): string {
  const t = text.trim()
  const end = /[.?!](?=\s|$)/.exec(t)
  const s = end ? t.slice(0, end.index + 1) : t
  return s.length <= MAX ? s : `${s.slice(0, MAX).trimEnd()}…`
}

/** Where a sample question's gold answer was found: the piece's rank and the answer it holds. */
function goldFound(question: string, rows: readonly HitRowData[], questions: readonly SampleQuestion[]): { rank: number; gold: string } | null {
  const q = questions.find((s) => s.question.trim() === question.trim())
  if (!q) return null
  const golds = [q.gold_answer, ...(q.gold_answers ?? [])]
  const rank = goldRank(rows, golds)
  if (rank === null) return null
  const row = rows.filter((r) => r.rank === rank)
  const gold = golds.find((g) => goldRank(row, [g]) !== null)
  return gold ? { rank, gold } : null
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
  if (chat || !rows.length) return null
  const found = goldFound(question, rows, questions)
  return (
    <p data-testid="finding-sentence" className="m-0 max-w-[46ch] font-sans text-lg text-balance">
      {found ? (
        <>
          {`Found in the ${ordinal(found.rank)} piece: `}
          <q className="font-serif italic" style={{ quotes: '"“" "”"' }}>
            {found.gold}
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
