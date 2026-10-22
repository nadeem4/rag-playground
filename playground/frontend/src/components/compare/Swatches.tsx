import type { FileInfo } from "@/lib/files"

/** One place in a search's top 5: the piece's number, its palette slot, and whether it holds the known answer. */
export interface SwatchPiece {
  piece: number
  slot: number
  answer: boolean
  /** The file the piece came from, when the pipeline has several: the swatch takes the file's colour. */
  file?: Pick<FileInfo, "filename" | "slot">
}

/**
 * A search's top 5 as five small squares: each the piece's number in mono on
 * its colour from the chunk palette, the same in every row, so rows that
 * found the same pieces look alike. With several documents each square is in
 * its file's colour instead, and its name and title say the file, so colour
 * is never the only cue. The answer's piece has a ring; a place the list did
 * not fill is a dashed square. Not controls, so 26 px.
 */
export function Swatches({ pieces }: { pieces: SwatchPiece[] }) {
  const top = pieces.slice(0, 5)
  const words = top.map((p) => `piece ${p.piece}${p.file ? ` from ${p.file.filename}` : ""}${p.answer ? " (the answer)" : ""}`).join(", ")
  return (
    <span role="img" aria-label={top.length ? `Top ${top.length}: ${words}` : "Nothing returned"} className="inline-flex gap-1">
      {[0, 1, 2, 3, 4].map((k) => {
        const p = top[k]
        return p ? (
          <span
            key={k}
            title={p.file?.filename}
            className={`inline-flex size-[26px] items-center justify-center rounded-swatch font-mono text-xs ${p.answer ? "outline-2 outline-offset-1 outline-fg" : ""}`}
            style={
              p.file
                ? { background: `var(--file-${p.file.slot})`, color: "var(--surface)" }
                : { background: `var(--chunk-${p.slot})`, color: `var(--chunk-${p.slot}-text)` }
            }
          >
            {p.piece}
          </span>
        ) : (
          <span key={k} className="inline-block size-[26px] rounded-swatch border border-dashed border-hairline" />
        )
      })}
    </span>
  )
}
