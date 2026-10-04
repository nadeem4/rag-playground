import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { cn } from "@/lib/utils"

/**
 * The top of a Compare column: the recipe in words and its code name beside
 * it. Recipes are changed on the cards before a run, not here. A finished
 * recipe that is not the run's baseline offers Use on Build, which puts it on
 * the pipeline; once it is there, it says so.
 */
export function RecipeHead({
  name,
  code,
  own,
  onUse,
  used = false,
}: {
  name: string
  code: string
  /** The recipe was the node's own on Build when the run started. */
  own: boolean
  /** Put this recipe on Build. */
  onUse?: () => void
  /** The recipe is the one on Build now. */
  used?: boolean
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
      {used ? (
        <span className="text-sm text-fg-muted">Now on Build</span>
      ) : onUse ? (
        <span>
          <button
            type="button"
            onClick={onUse}
            className={cn(LINK_BUTTON, "self-start text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center")}
          >
            Use on Build
          </button>
        </span>
      ) : null}
    </div>
  )
}
