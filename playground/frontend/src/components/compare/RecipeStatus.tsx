import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { cn } from "@/lib/utils"
import { statusText, type RecipeStatus as Status } from "@/state/compare"

const DOT: Record<Status["kind"], string> = {
  waiting: "bg-flat",
  running: "bg-primary ring-4 ring-accent-wash",
  failed: "bg-danger",
  stopped: "bg-flat",
  done: "bg-primary",
}

/**
 * One recipe's place in a run, in a sentence: a dot for its state, the
 * sentence with the seconds the browser counted in mono, and on a failure
 * Change this recipe, which goes back to that recipe's card.
 */
export function RecipeStatus({ status, seconds, onChange }: { status: Status; seconds: number | null; onChange?: () => void }) {
  const text = statusText(status, seconds)
  const secs = status.kind === "running" ? `${seconds ?? 0} s` : null
  return (
    <p data-testid="recipe-status" className="m-0 flex items-baseline gap-2 text-sm text-fg-muted">
      <span data-dot aria-hidden className={cn("inline-block size-[8px] shrink-0 translate-y-[-1px] rounded-full", DOT[status.kind])} />
      <span className={cn("min-w-0 break-words", status.kind === "failed" && "text-danger")}>
        {secs ? (
          <>
            {text.slice(0, -secs.length)}
            <span className="font-mono">{secs}</span>
          </>
        ) : (
          text
        )}
        {status.kind === "failed" && onChange ? (
          <>
            {" "}
            <button
              type="button"
              onClick={onChange}
              className={cn(LINK_BUTTON, "text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center")}
            >
              Change this recipe
            </button>
          </>
        ) : null}
      </span>
    </p>
  )
}
