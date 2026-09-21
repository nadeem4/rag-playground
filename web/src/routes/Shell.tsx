import { EmptyState } from "@/components/EmptyState"

/**
 * The two-pane instrument: the pipeline column on the left, the inspector on
 * the right. B1 ships the frame only; stage cards (B3) and inspectors (B4)
 * mount into these panes.
 */
export function Shell() {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-hairline md:grid-cols-[360px_minmax(0,1fr)]">
      <section aria-label="Pipeline" className="flex min-h-0 flex-col bg-surface">
        <div className="flex h-[40px] shrink-0 items-center border-b border-hairline px-3">
          <h1 className="text-xl font-semibold">Pipeline</h1>
        </div>
        <EmptyState title="No source loaded">
          Upload a PDF to start a pipeline. Its stages, Load, Clean and Chunk, will appear here.
        </EmptyState>
      </section>
      <section aria-label="Inspector" className="flex min-h-0 flex-col bg-surface">
        <div className="flex h-[40px] shrink-0 items-center border-b border-hairline px-3">
          <h2 className="text-xl font-semibold">Inspector</h2>
        </div>
        <EmptyState title="Nothing to inspect">
          Run a stage, then select it to see its output here.
        </EmptyState>
      </section>
    </main>
  )
}
