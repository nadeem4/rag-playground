import { optionLabel } from "./schema"
import type { ControlProps } from "./types"
import { CONTROL } from "./types"

/** Python `Literal[...]`, inline or through `$defs`. Emits the option's own type. */
export function EnumField({ f, id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const known = f.options.some((o) => o === value)
  return (
    <select
      id={id}
      className={CONTROL}
      value={known ? String(value) : ""}
      // A long value can be cut off in a narrow block; the tooltip has it whole.
      title={known ? optionLabel(f.schema, value) : undefined}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(f.options.find((o) => String(o) === e.target.value))}
    >
      {known ? null : <option value="" disabled hidden />}
      {f.options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {optionLabel(f.schema, o)}
        </option>
      ))}
    </select>
  )
}
