/**
 * The top of a Compare column: the recipe in words and its code name beside
 * it. Recipes are changed on the cards before a run, not here.
 */
export function RecipeHead({
  name,
  code,
  own,
}: {
  name: string
  code: string
  /** The recipe is the node's own on Build. */
  own: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {own ? (
        <span>
          <span className="inline-block rounded-swatch bg-surface-elevated px-2 py-px text-xs font-semibold text-fg-muted">Your pipeline</span>
        </span>
      ) : null}
      <h2 className="text-base font-semibold break-words">{name}</h2>
      <span className="font-mono text-xs break-all text-fg-muted">{code}</span>
    </div>
  )
}
