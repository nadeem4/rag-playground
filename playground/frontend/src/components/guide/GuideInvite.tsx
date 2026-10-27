import { Button } from "@/components/ui/button"
import { GUIDE_INVITE, setGuideHidden } from "@/state/guide"

/** Offers the guided run to newcomers; "hide" is remembered in this browser. */
export function GuideInvite({ onStart }: { onStart: () => void }) {
  return (
    <section
      aria-label="Guided run invitation"
      className="flex min-w-0 flex-col gap-3 rounded-panel border border-primary bg-surface-raised p-4 shadow-raised"
    >
      <h2 className="m-0 text-base font-semibold text-fg">{GUIDE_INVITE.heading}</h2>
      <p className="m-0 max-w-[60ch] text-sm text-muted-foreground">{GUIDE_INVITE.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onStart}>{GUIDE_INVITE.start}</Button>
        <Button variant="ghost" onClick={() => setGuideHidden(true)}>
          {GUIDE_INVITE.hide}
        </Button>
      </div>
    </section>
  )
}
