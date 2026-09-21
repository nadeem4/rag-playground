/**
 * Channel B utility classes, spelled out in full so Tailwind's scanner sees
 * them (it cannot see `bg-chunk-${n}`). Index with `slot - 1`.
 */

/** Fill plus its paired, contrast-checked text color, for slots 1..8. */
export const CHUNK_CLASSES = [
  "bg-chunk-1 text-chunk-1-text",
  "bg-chunk-2 text-chunk-2-text",
  "bg-chunk-3 text-chunk-3-text",
  "bg-chunk-4 text-chunk-4-text",
  "bg-chunk-5 text-chunk-5-text",
  "bg-chunk-6 text-chunk-6-text",
  "bg-chunk-7 text-chunk-7-text",
  "bg-chunk-8 text-chunk-8-text",
] as const

/** Score steps 1 (lowest) .. 5 (highest). */
export const SCORE_CLASSES = [
  "bg-score-1",
  "bg-score-2",
  "bg-score-3",
  "bg-score-4",
  "bg-score-5",
] as const
