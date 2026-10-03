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
  className?: string
}

/**
 * One row of choices, one of them pressed. The one pressed style in the app:
 * the accent wash fill, accent text and a 1px accent ring (the border). The
 * others are flat. Used for Rerank, Answer with, the theme and the contrast.
 */
export function SegmentedControl({ options, value, onChange, label, size = "sm", className }: SegmentedControlProps) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
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
