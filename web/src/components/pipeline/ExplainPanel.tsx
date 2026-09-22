import type { ReactNode } from "react"
import { Popover } from "radix-ui"

import type { ExplainState } from "@/api/useExplain"
import { Button } from "@/components/ui/button"

/**
 * The pop-over beside a card (option B): what the step is for, how the chosen
 * transform works, what it will do with the card's current settings, and the
 * trade-off. Rendered inside the card's Popover.Root; Radix supplies Escape,
 * outside-click dismissal and focus return to the info button.
 */

export interface ExplainPanelProps {
  title: string
  transform: string
  what?: string
  summary?: string
  explain?: ExplainState
  /** The card: interacting with it keeps the pop-over open, so settings can be edited beside it. */
  anchor: () => HTMLElement | null
}

function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold">{label}</h4>
      {children}
    </section>
  )
}

const BODY = "m-0 text-sm leading-[1.55] text-fg-muted"

export function ExplainPanel({ title, transform, what, summary, explain, anchor }: ExplainPanelProps) {
  const data = explain?.data
  const keepOpen = (e: Event) => {
    const card = anchor()
    if (card && e.target instanceof Node && card.contains(e.target)) e.preventDefault()
  }
  return (
    <Popover.Portal>
      <Popover.Content
        side="right"
        align="start"
        sideOffset={16}
        collisionPadding={16}
        aria-label={`About the ${title} step`}
        onInteractOutside={keepOpen}
        onCloseAutoFocus={(e) => {
          // Focus returns to the info button only when it would otherwise be
          // lost. When another card's pop-over replaced this one, focus is
          // already there, and moving it back would close that one.
          const active = document.activeElement
          if (active && active !== document.body) e.preventDefault()
        }}
        className="z-10 flex w-[400px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-panel border border-fg-muted bg-surface p-3 text-fg"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Popover.Close asChild>
            <Button variant="outline" size="sm">
              Close
            </Button>
          </Popover.Close>
        </div>
        {what ? (
          <Part label="What this step does">
            <p className={BODY}>{what}</p>
          </Part>
        ) : null}
        {summary ? (
          <Part
            label={
              <>
                How <span className="font-mono">{transform}</span> works
              </>
            }
          >
            <p className={BODY}>{summary}</p>
          </Part>
        ) : null}
        <Part label="With your settings">
          <div aria-live="polite" className="flex flex-col gap-1">
            {explain?.invalid ? (
              <p className="m-0 text-sm leading-[1.55] whitespace-pre-wrap text-danger">These settings are not valid. {explain.invalid}</p>
            ) : data ? (
              <>
                <p className={BODY}>{data.settings}</p>
                {data.warning ? <p className="m-0 text-sm leading-[1.55] text-danger">{data.warning}</p> : null}
                {data.tradeoff ? <p className={BODY}>Trade-off: {data.tradeoff}</p> : null}
              </>
            ) : (
              <p className={BODY}>Loading</p>
            )}
          </div>
        </Part>
      </Popover.Content>
    </Popover.Portal>
  )
}
