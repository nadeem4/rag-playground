import { useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"

import { cn } from "@/lib/utils"
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme"

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
]

/** A three-way segmented control. Selection is the one accent use here. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-3 gap-px overflow-hidden rounded-control border border-hairline bg-hairline"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = choice === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={label}
            aria-label={label}
            onClick={() => {
              setChoice(value)
              applyTheme(value)
            }}
            className={cn(
              "flex h-row-compact items-center gap-1 px-2 text-xs",
              selected ? "bg-selection text-fg" : "bg-surface text-fg-muted hover:bg-muted",
            )}
          >
            <Icon aria-hidden className="size-[12px]" strokeWidth={1.75} />
            <span className="hidden md:inline">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
