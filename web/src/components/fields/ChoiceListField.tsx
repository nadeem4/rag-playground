import { alwaysOn, optionLabel } from "./schema"
import type { ControlProps } from "./types"

/**
 * A list of fixed choices (`list[Literal[...]]`): one checkbox per choice, in
 * schema order. The value emitted is the checked choices in that same order.
 * Choices named in the schema's `x-always` are drawn checked and disabled, and
 * are never removed from the value, because the server always adds them back.
 */
export function ChoiceListField({ f, id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const fixed = alwaysOn(f.schema)
  const picked = new Set<unknown>(Array.isArray(value) ? value : [])
  const isOn = (o: unknown) => fixed.has(o) || picked.has(o)
  const toggle = (o: unknown) => onChange(f.options.filter((x) => (x === o ? !isOn(x) : isOn(x))))

  return (
    <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
      {f.options.map((o, i) => {
        const boxId = i === 0 ? id : `${id}-${i}`
        return (
          <label key={String(o)} htmlFor={boxId} className="flex items-center gap-2 text-sm text-fg select-none">
            <input
              id={boxId}
              type="checkbox"
              value={String(o)}
              className="size-[14px] shrink-0 [accent-color:var(--text-primary)]"
              checked={isOn(o)}
              disabled={disabled || fixed.has(o)}
              title={fixed.has(o) ? "Always on" : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={() => toggle(o)}
            />
            {optionLabel(f.schema, o)}
          </label>
        )
      })}
    </div>
  )
}
