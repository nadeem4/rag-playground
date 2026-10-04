import type { ReactNode, Ref } from "react"
import { X } from "lucide-react"

import type { Stage } from "@/api/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SentencePart } from "@/state/recipeSentence"

/** The tag at a card's top left: whose recipe it is, or that it changed. */
export type CardTag = "Your pipeline" | "Edited" | "New" | `Recipe ${number}`

/** The results' outline in the lower third of a card, by stage. */
const GHOST: Partial<Record<Stage, string[]>> = {
  chunk: ["pieces", "tokens", "median", "left out"],
  retrieve: ["answer", "shared", "returned"],
}

/**
 * One recipe before the run: a card of the same size as every other, with its
 * tag, the recipe as a sentence in which each value is a button, its code
 * name, and in its lower third a dashed outline of what the run will show
 * there. The one floating editor, when it belongs to this card, is passed in
 * as `editor` and laid over the card.
 */
export function RecipeCard({
  index,
  own,
  tag,
  parts,
  code,
  stage,
  placeholder,
  openField,
  onOpen,
  onRemove,
  editor,
  error,
  cardRef,
}: {
  index: number
  /** The node's own recipe on Build. */
  own: boolean
  tag: CardTag
  parts: SentencePart[]
  code: string
  stage: Stage
  /** What happens to this recipe after the run, as a sentence. */
  placeholder: string
  /** The field whose editor is open on this card. */
  openField: string | null
  onOpen: (field: string, button: HTMLButtonElement) => void
  onRemove?: () => void
  editor?: ReactNode
  /** The server's message about this recipe, under its sentence. */
  error?: string | null
  cardRef?: Ref<HTMLElement>
}) {
  const label = own ? "Your pipeline" : `Recipe ${index + 1}`
  const ghost = GHOST[stage]
  return (
    <article
      ref={cardRef}
      aria-label={label}
      tabIndex={-1}
      className={cn(
        "relative flex min-h-[320px] min-w-0 flex-col gap-3 rounded-panel border border-hairline p-[20px] outline-none",
        own ? "bg-accent-wash/40" : "bg-surface-raised",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-block rounded-swatch px-2 py-px text-xs font-semibold",
            tag === "Your pipeline" ? "bg-accent-wash text-primary" : tag === "Edited" ? "bg-stale-wash text-stale" : "bg-surface-elevated text-fg-muted",
          )}
        >
          {tag}
        </span>
        {onRemove ? (
          <Button variant="ghost" size="icon" aria-label={`Remove recipe ${index + 1}`} title="Remove this recipe" onClick={onRemove} className="pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]">
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
      <p className="m-0 font-serif text-[1.1875rem] leading-[1.9] break-words">
        {parts.map((p, k) =>
          p.field ? (
            <button
              key={k}
              type="button"
              data-value={p.field}
              aria-expanded={openField === p.field}
              aria-label={`Change ${p.field === "transform" ? "the strategy" : p.field.replace(/_/g, " ")}, now ${p.text}`}
              onClick={(e) => onOpen(p.field!, e.currentTarget)}
              className={cn(
                "rounded-control border-b border-dashed border-fg-muted px-1 font-sans text-[1.0625rem] font-medium text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center",
                openField === p.field && "bg-accent-wash text-primary",
              )}
            >
              {p.text}
            </button>
          ) : (
            <span key={k}>{p.text}</span>
          ),
        )}
      </p>
      {error ? (
        <p role="alert" className="m-0 text-sm break-words text-danger">
          {error}
        </p>
      ) : null}
      <p data-testid="recipe-code" className="m-0 font-mono text-xs break-all text-fg-muted">
        {code}
      </p>
      <div className="mt-auto flex min-h-[96px] flex-col gap-2 rounded-panel border border-dashed border-hairline p-3">
        <p className="m-0 text-xs text-fg-muted">{placeholder}</p>
        {ghost ? (
          <div aria-hidden className="flex flex-col gap-2">
            <div className="flex gap-4">
              {ghost.map((g) => (
                <span key={g} className="flex flex-col gap-1 text-2xs text-fg-muted">
                  <span className="h-[14px] w-[28px] rounded-swatch bg-surface-elevated" />
                  {g}
                </span>
              ))}
            </div>
            {stage === "chunk" ? (
              <span className="h-[10px] rounded-swatch bg-surface-elevated" />
            ) : (
              <span className="flex gap-1">
                {[0, 1, 2, 3, 4].map((k) => (
                  <span key={k} className="size-[20px] rounded-swatch border border-dashed border-hairline" />
                ))}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {editor}
    </article>
  )
}
