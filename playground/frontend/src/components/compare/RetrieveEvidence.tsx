import type { ChunkSet } from "@/api/types"
import type { HitRowData } from "@/components/inspectors/hits"
import { RetrievalView } from "@/components/inspectors/RetrievalResultInspector"
import { MonoNumbers } from "@/components/pipeline/WhatItDid"

/**
 * A Compare search column as evidence: the sentence that says how its list
 * differs from the baseline's, then the ranked pieces as flat, compact slips.
 * The hit, candidate and timing facts stay on Build. The piece that holds a
 * known answer says so on its finding line.
 */
export function RetrieveEvidence({
  rows,
  chunkSet,
  agreement,
  answer,
}: {
  rows: HitRowData[]
  /** The chunk set searched: each slip's piece number and colour. */
  chunkSet?: ChunkSet
  agreement: string | null
  /** The chunk id of the piece that holds the sample's gold answer, or null when it is not known. */
  answer: string | null
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {agreement ? (
        <p data-testid="agreement" className="m-0 text-sm font-semibold text-fg">
          <MonoNumbers text={agreement} />
        </p>
      ) : null}
      <RetrievalView rows={rows} chunkSet={chunkSet} facts={null} showDetail={false} flat compact answer={answer} />
    </div>
  )
}
