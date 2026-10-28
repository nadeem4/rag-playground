import type { ArtifactType, Stage } from "@/api/types"
import { ordinal } from "@/components/inspectors/hits"
import { fmt } from "@/components/inspectors/status"
import { outcomeFor, outcomeText } from "@/components/pipeline/outcome"

/** Where the target piece landed: its 1-based rank, or null when it was not returned. */
export type Found = { rank: number } | null

/** The coach's one-line result for a build step, from the real artifact. */
export function stepResultLine(
  stage: Stage,
  type: ArtifactType | undefined,
  data: unknown,
  doc: { filename: string; pages?: number },
): string | null {
  if (stage === "source") {
    if (doc.pages === undefined) return doc.filename
    return `${doc.filename} · ${fmt(doc.pages)} ${doc.pages === 1 ? "page" : "pages"}`
  }
  const o = outcomeFor(stage, type, data)
  return o ? outcomeText(o) : null
}

/** What the answer step can see: the target piece among the pieces it reads, below them, or missing. */
export function askResultLine(f: { found: Found; shown: number; candidates: number }): string {
  const read = `${fmt(f.shown)} ${f.shown === 1 ? "piece" : "pieces"}`
  if (!f.found) return `No piece that was returned holds the answer. Search looked through ${fmt(f.candidates)} ${f.candidates === 1 ? "piece" : "pieces"}.`
  if (f.found.rank <= f.shown) {
    return `The piece with the answer is ${ordinal(f.found.rank)}, so it is among the ${read} the answer step reads.`
  }
  return `The piece with the answer is ${ordinal(f.found.rank)}, which is below the ${read} the answer step reads.`
}

/** The fix helped only when the answer is now found and was missing or ranked lower before. */
export function fixImproved(f: { before: Found; after: Found }): boolean {
  return f.after !== null && (f.before === null || f.after.rank < f.before.rank)
}

/** What a fix changed: the rank before and after, never an invented rank. `chunk` is the real Chunk outcome, added as its own sentence. */
export function fixResultLine(f: { before: Found; after: Found; chunk: string | null }): string {
  const tail = f.chunk ? ` ${f.chunk}` : ""
  return `${rankSentence(f)}${tail}`
}

function rankSentence({ before, after }: { before: Found; after: Found }): string {
  if (!after) {
    return before
      ? `The piece with the answer was ${ordinal(before.rank)} before, and it is still not found.`
      : "The piece with the answer is still not found."
  }
  if (!before) return `The piece with the answer was not found before. Now it is ${ordinal(after.rank)}.`
  if (after.rank === before.rank) return `The piece with the answer is still ${ordinal(after.rank)}, the same as before.`
  if (after.rank < before.rank) return `The piece with the answer moved from ${ordinal(before.rank)} to ${ordinal(after.rank)}.`
  return `The piece with the answer fell from ${ordinal(before.rank)} to ${ordinal(after.rank)}.`
}
