/**
 * The files of a pipeline with several documents, each with its colour.
 * A document's colour comes from its place in the pipeline's list (spec "File
 * colours"): the first is `--file-1`, the second `--file-2`, and after the
 * sixth they start again. A file is always named beside its colour, so colour
 * is never the only cue (FileTag). With one document there are no file tags
 * at all, so every screen stays as it was.
 */

/** How many file colours there are (`--file-1` to `--file-6` in tokens.css). */
export const FILE_COLOURS = 6

/** A document's colour slot, 1 to 6, by its place in the pipeline's documents (from 0). */
export function fileSlot(order: number): number {
  return (order % FILE_COLOURS) + 1
}

export interface FileInfo {
  sha: string
  filename: string
  /** Its colour: `var(--file-<slot>)`. */
  slot: number
  /** The category it is pinned to, when a pipeline pins it. */
  category?: string
}

/** The pipeline's files with their colours, in order; none with fewer than two documents. */
export function filesOf(docs: readonly { sha: string; filename: string; category?: string }[]): FileInfo[] {
  return docs.length < 2 ? [] : docs.map((d, i) => ({ sha: d.sha, filename: d.filename, slot: fileSlot(i), ...(d.category ? { category: d.category } : {}) }))
}

/** The file with this sha, when there are several files and it is one of them. */
export function fileOf<F extends FileInfo>(files: readonly F[], sha: string | null | undefined): F | undefined {
  return sha ? files.find((f) => f.sha === sha) : undefined
}
