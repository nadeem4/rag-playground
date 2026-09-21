import { Input } from "@/components/ui/input"
import type { ControlProps } from "./types"

export function TextField({ id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  return (
    <Input
      id={id}
      type="text"
      spellCheck={false}
      autoComplete="off"
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
