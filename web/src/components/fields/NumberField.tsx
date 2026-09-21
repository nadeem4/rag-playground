import { Input } from "@/components/ui/input"
import type { ControlProps } from "./types"

/** `integer` and `number`. Mono, tabular. An emptied input emits `null`, which
 *  validation flags on a required field instead of silently keeping the old value. */
export function NumberField({ f, id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const s = f.schema
  const bounded = s.minimum !== undefined && s.maximum !== undefined
  const step = f.kind === "integer" ? 1 : bounded && s.maximum! - s.minimum! <= 1 ? 0.01 : "any"
  return (
    <Input
      id={id}
      type="number"
      inputMode={f.kind === "integer" ? "numeric" : "decimal"}
      className="tabular-nums"
      step={step}
      min={s.minimum ?? s.exclusiveMinimum}
      max={s.maximum ?? s.exclusiveMaximum}
      value={typeof value === "number" ? String(value) : ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  )
}
