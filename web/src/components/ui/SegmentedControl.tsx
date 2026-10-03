import { useId } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface SegmentedOption {
  value: string
  label: string
  disabled?: boolean
  /** Shown on hover; the reason when the option is disabled. */
  title?: string
}

export interface SegmentedControlProps {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  /** The group's accessible name. */
  label: string
  size?: "sm" | "default"
  /**
   * Show `label` as a small caption before the options, naming the group:
   * "md" from md up only (hidden from sight, still read, below md), "always"
   * everywhere. Without it the group is named by an aria-label alone.
   */
  caption?: "md" | "always"
  className?: string
}

/**
 * One row of choices, one of them pressed. The one pressed style in the app:
 * the accent wash fill, accent text and a 1px accent ring (the border). The
 * others are flat. Used for Rerank, Answer with, the theme and the contrast.
 */
export function SegmentedControl({ options, value, onChange, label, size = "sm", caption, className }: SegmentedControlProps) {
  const captionId = useId()
  return (
    <div
      role="group"
      aria-label={caption ? undefined : label}
      aria-labelledby={caption ? captionId : undefined}
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {caption ? (
        <span id={captionId} className={cn("mr-1 text-xs text-fg-muted", caption === "md" && "sr-only md:not-sr-only")}>
          {label}
        </span>
      ) : null}
      {options.map((o) => {
        const pressed = o.value === value
        return (
          <Button
            key={o.value}
            type="button"
            variant="ghost"
            size={size}
            disabled={o.disabled}
            title={o.title}
            aria-pressed={pressed}
            className={cn(pressed ? "border-primary bg-accent-wash text-primary hover:bg-accent-wash" : "border-transparent text-fg-muted hover:text-fg")}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        )
      })}
    </div>
  )
}
