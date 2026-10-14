import type { Variant } from "@/api/types"

/** A recipe the Add card offers: its name and why someone would try it. */
export interface Suggestion {
  name: string
  reason: string
  variant: Variant
}

/**
 * The card after the recipes, the same size as theirs. Below the cap it
 * offers up to three recipes not already on the page, Start from defaults,
 * and how many of the most a run takes are used. At the cap it says why
 * nothing more can be added.
 */
export function AddRecipeCard({
  count,
  max,
  suggestions,
  onAdd,
  onDefaults,
}: {
  count: number
  max: number
  suggestions: Suggestion[]
  onAdd: (v: Variant) => void
  onDefaults: () => void
}) {
  const full = count >= max
  return (
    <section aria-label="Add a recipe" className="flex min-h-[320px] min-w-0 flex-col gap-3 rounded-panel border border-dashed border-hairline p-[20px]">
      <h2 className="m-0 text-base font-semibold">Add a recipe</h2>
      {full ? (
        <p className="m-0 text-sm text-fg-muted">Ten recipes is the most one run takes. Remove one to add another.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {suggestions.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => onAdd(s.variant)}
                className="flex min-h-row flex-col items-start gap-px rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-[44px]"
              >
                <span className="text-sm font-medium">{s.name}</span>
                <small className="text-xs text-fg-muted">{s.reason}</small>
              </button>
            ))}
            <button
              type="button"
              onClick={onDefaults}
              className="flex min-h-row flex-col items-start gap-px rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) pointer-coarse:min-h-[44px]"
            >
              <span className="text-sm font-medium">Start from defaults</span>
              <small className="text-xs text-fg-muted">Pick any strategy and set it yourself.</small>
            </button>
          </div>
          <p className="m-0 mt-auto text-xs text-fg-muted">
            {count} of {max} recipes.
          </p>
        </>
      )}
    </section>
  )
}
