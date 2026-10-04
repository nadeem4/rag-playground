import { useId } from "react"
import { Info } from "lucide-react"
import { Popover } from "radix-ui"

import type { Lesson } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Help } from "./FieldShell"

/**
 * The info button beside a field's label, and the pop-over it opens: the
 * field's title, its full description, and its lesson when it has one. Radix
 * supplies Escape, outside-click dismissal and focus return to the button.
 * With nothing to say, it renders nothing.
 */
export function FieldHelp({ title, text, lesson }: { title: string; text?: string; lesson?: Lesson }) {
  const headingId = useId()
  if (!text && !lesson) return null
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`About ${title}`}
          title={`About ${title}`}
          className="size-[20px] text-fg-muted"
          onClick={(e) => e.stopPropagation()}
        >
          <Info aria-hidden strokeWidth={1.75} className="size-[16px]" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          aria-labelledby={headingId}
          // The pop-over is portalled, but React events still bubble to the card; keep them off it.
          onClick={(e) => e.stopPropagation()}
          className="z-30 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-panel border border-fg-muted bg-surface p-3 text-fg"
        >
          <h3 id={headingId} className="text-sm font-semibold">
            {title}
          </h3>
          {text ? (
            <Help text={text} className="m-0 text-sm leading-[1.55] text-fg-muted" />
          ) : null}
          {lesson ? (
            <div data-learn="" className="flex flex-col gap-1 text-sm leading-[1.55] text-fg-muted">
              <p className="m-0">{lesson.hint}</p>
              {lesson.more.map((p) => (
                <p key={p} className="m-0">
                  {p}
                </p>
              ))}
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
