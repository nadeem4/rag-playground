import { Button } from "@/components/ui/button"

/** Asks before the guided run replaces a pipeline the reader has changed. */
export function GuideReplace({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  return (
    <section
      aria-label="Replace the pipeline"
      className="flex min-w-0 flex-col gap-3 rounded-panel border border-primary bg-surface-raised p-4 shadow-raised"
    >
      <p className="m-0 text-sm text-fg">This replaces the pipeline you are working on. Save it first with Save as.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onContinue}>Continue</Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
