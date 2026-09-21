import type { ControlProps } from "./types"

/** A checkbox. Checked fill is the primary text tint, not the UI accent. */
export function BooleanField({ id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  return (
    <input
      id={id}
      type="checkbox"
      className="size-[14px] shrink-0 [accent-color:var(--text-primary)]"
      checked={value === true}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}
