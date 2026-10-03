import { useState } from "react"

import { SegmentedControl } from "@/components/ui/SegmentedControl"
import { applyContrast, readContrast, type ContrastChoice } from "@/lib/contrast"
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme"

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const CONTRASTS = [
  { value: "system", label: "System" },
  { value: "more", label: "More", title: "More contrast" },
]

/** System, Light or Dark for the whole page. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)
  return (
    <SegmentedControl
      label="Theme"
      options={THEMES}
      value={choice}
      className="gap-0"
      onChange={(v) => {
        setChoice(v as ThemeChoice)
        applyTheme(v as ThemeChoice)
      }}
    />
  )
}

/** System follows the OS setting; More pins the more-contrast tokens. */
export function ContrastToggle() {
  const [choice, setChoice] = useState<ContrastChoice>(readContrast)
  return (
    <SegmentedControl
      label="Contrast"
      options={CONTRASTS}
      value={choice}
      className="gap-0"
      onChange={(v) => {
        setChoice(v as ContrastChoice)
        applyContrast(v as ContrastChoice)
      }}
    />
  )
}
