import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { cn } from "@/lib/utils"

/**
 * The top of a Compare column: the recipe in words, its code name beside it,
 * and Change this recipe, which unfolds the editor below. A recipe edited
 * since the last run says so here, so it shows while the editor is folded.
 */
export function RecipeHead({
  name,
  code,
  own,
  edited,
  open,
  controls,
  onToggle,
}: {
  name: string
  code: string
  /** The recipe is the node's own on Build. */
  own: boolean
  /** The recipe changed after the run that produced the result below. */
  edited: boolean
  /** The editor is unfolded. */
  open: boolean
  /** The editor's element id. */
  controls: string
  onToggle: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {own ? (
        <span>
          <span className="inline-block rounded-swatch bg-surface-elevated px-2 py-0.5 text-xs font-semibold text-fg-muted">Your pipeline</span>
        </span>
      ) : null}
      <h2 className="text-base font-semibold break-words">{name}</h2>
      <span className="font-mono text-xs break-all text-fg-muted">{code}</span>
      <span className="flex flex-wrap items-baseline gap-x-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={controls}
          onClick={onToggle}
          className={cn(LINK_BUTTON, "self-start text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center")}
        >
          {open ? "Done" : "Change this recipe"}
        </button>
      </span>
      {/* Marked as Build marks a setting changed since its run. */}
      {edited ? <p className="self-start rounded-swatch bg-stale-wash px-2 py-0.5 text-xs text-stale">Edited since the last run. Run again to update the result below.</p> : null}
    </div>
  )
}
