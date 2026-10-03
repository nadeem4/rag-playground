import { useState } from "react"
import { Popover } from "radix-ui"

import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/SegmentedControl"
import { applyContrast, readContrast, type ContrastChoice } from "@/lib/contrast"
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme"

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

/** Normal follows the OS setting; More contrast pins the more-contrast tokens. */
const CONTRASTS = [
  { value: "system", label: "Normal" },
  { value: "more", label: "More contrast" },
]

/**
 * The theme and contrast switches. From md up they sit in the header with a
 * small caption each; below md they wait behind a Display button, so the
 * phone header stays two rows. One state feeds both places.
 */
export function DisplaySettings() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [contrast, setContrast] = useState<ContrastChoice>(readContrast)

  const switches = (caption: "md" | "always") => (
    <>
      <SegmentedControl
        label="Theme"
        caption={caption}
        options={THEMES}
        value={theme}
        className="gap-0"
        onChange={(v) => {
          setTheme(v as ThemeChoice)
          applyTheme(v as ThemeChoice)
        }}
      />
      <SegmentedControl
        label="Contrast"
        caption={caption}
        options={CONTRASTS}
        value={contrast}
        className="gap-0"
        onChange={(v) => {
          setContrast(v as ContrastChoice)
          applyContrast(v as ContrastChoice)
        }}
      />
    </>
  )

  return (
    <>
      <div className="hidden items-center gap-3 md:flex">{switches("md")}</div>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button variant="outline" size="sm" className="md:hidden">
            Display
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={4}
            aria-label="Display"
            className="z-10 flex max-w-[calc(100vw-24px)] flex-col gap-2 rounded-panel border border-hairline bg-surface-elevated p-3 text-fg"
          >
            {switches("always")}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  )
}
