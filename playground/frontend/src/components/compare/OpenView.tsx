import type { ReactNode, Ref } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RecipeStatus } from "@/state/compare"

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const word = (n: number) => WORDS[n] ?? String(n)
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** One chip in the strip: a recipe in the overview's order. */
export interface Chip {
  i: number
  label: string
  kind: RecipeStatus["kind"]
}

const SUFFIX: Record<RecipeStatus["kind"], string> = { done: "", running: ", running", waiting: ", waiting", failed: ", failed", stopped: ", not run" }
const DOT: Partial<Record<RecipeStatus["kind"], string>> = {
  waiting: "bg-flat",
  running: "bg-primary ring-4 ring-accent-wash",
  failed: "bg-danger",
  stopped: "bg-flat",
}

/**
 * Up to three recipes read side by side, opened from the overview. A back
 * control at the top left, a strip of every recipe in the overview's order
 * (it scrolls inside itself when the chips do not fit; the page never does),
 * a line that says what is next, the columns, then Previous and Next.
 */
export function OpenView({
  total,
  shown,
  chips,
  onChip,
  onBack,
  backRef,
  nextLine,
  position,
  onStep,
  children,
  note,
  baseName = "Your pipeline",
}: {
  total: number
  shown: number[]
  chips: Chip[]
  onChip: (i: number) => void
  onBack: () => void
  backRef?: Ref<HTMLButtonElement>
  nextLine: string | null
  /** Where the one recipe read sits in the overview's order; null when several are read together. */
  position: { at: number; of: number; beside: boolean; prev: boolean; next: boolean } | null
  onStep: (delta: 1 | -1) => void
  children: ReactNode
  note: string | null
  /** What the recipes are read beside: Your pipeline, or the baseline's phrase when no recipe was the pipeline's own. */
  baseName?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3">
        <Button ref={backRef} variant="ghost" size="sm" aria-label={`Back to all ${word(total)} recipes`} onClick={onBack} className="pointer-coarse:min-h-[44px]">
          <span aria-hidden>‹</span> All {word(total)} recipes
        </Button>
        <span className="text-sm text-fg-muted">{shown.length === 1 ? "One recipe" : `${cap(word(shown.length))} of ${word(total)}, side by side`}</span>
      </div>
      <div role="group" aria-label={`All ${word(total)} recipes`} className="flex min-w-0 gap-1 overflow-x-auto px-3 pb-1">
        {chips.map((c) => (
          <button
            key={c.i}
            type="button"
            aria-current={shown.includes(c.i) ? "true" : undefined}
            aria-label={c.label + SUFFIX[c.kind]}
            disabled={c.kind !== "done"}
            onClick={() => onChip(c.i)}
            className={cn(
              "inline-flex h-row-compact shrink-0 items-center gap-1 rounded-control border border-hairline px-2 text-xs whitespace-nowrap hover:bg-muted disabled:opacity-60 pointer-coarse:min-h-[44px]",
              shown.includes(c.i) && "border-primary bg-accent-wash text-primary",
            )}
          >
            {DOT[c.kind] ? <span aria-hidden className={cn("inline-block size-[8px] rounded-full", DOT[c.kind])} /> : null}
            {c.label}
          </button>
        ))}
      </div>
      {nextLine ? (
        <p aria-live="polite" className="m-0 px-3 text-sm text-fg-muted">
          {nextLine}
        </p>
      ) : null}
      {children}
      {note ? <p className="m-0 px-3 text-sm text-fg-muted">{note}</p> : null}
      {position ? (
        <div className="flex items-center justify-between gap-2 px-3">
          <Button variant="outline" size="sm" disabled={!position.prev} onClick={() => onStep(-1)} className="pointer-coarse:min-h-[44px]">
            Previous
          </Button>
          <span className="text-sm text-fg-muted">
            {position.at} of {position.of}
            {position.beside ? `, each beside ${baseName}` : ""}
          </span>
          <Button variant="outline" size="sm" disabled={!position.next} onClick={() => onStep(1)} className="pointer-coarse:min-h-[44px]">
            Next
          </Button>
        </div>
      ) : null}
    </div>
  )
}
