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
  const read = fmt(f.shown)
  if (!f.found) return `No piece that was returned holds the answer. Search looked through ${fmt(f.candidates)} pieces.`
  if (f.found.rank <= f.shown) {
    return `The piece with the answer is ${ordinal(f.found.rank)}, so it is among the ${read} pieces the answer step reads.`
  }
  return `The piece with the answer is ${ordinal(f.found.rank)}, which is below the ${read} pieces the answer step reads.`
}

/** What a fix changed: the rank before and after, never an invented rank. */
export function fixResultLine(f: { before: Found; after: Found; chunk: string | null }): string {
  const where = f.chunk ? ` in ${f.chunk}` : ""
  if (!f.after) {
    return f.before
      ? `The piece with the answer was ${ordinal(f.before.rank)} before, and it is still not found${where}.`
      : `The piece with the answer is still not found${where}.`
  }
  if (!f.before) return `The piece with the answer was not found before. Now it is ${ordinal(f.after.rank)}${where}.`
  return `The piece with the answer moved from ${ordinal(f.before.rank)} to ${ordinal(f.after.rank)}${where}.`
}
