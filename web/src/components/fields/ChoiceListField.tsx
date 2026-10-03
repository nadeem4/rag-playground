import { optionLabel } from "./schema"
import type { ControlProps } from "./types"

/**
 * Choices the server always adds back, so they are drawn checked and disabled.
 * Docling's content layers always include `body`: its validator adds it.
 */
const ALWAYS_ON = new Set<unknown>(["body"])

/**
 * A list of fixed choices (`list[Literal[...]]`): one checkbox per choice, in
 * schema order. The value emitted is the checked choices in that same order.
 */
export function ChoiceListField({ f, id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const picked = new Set<unknown>(Array.isArray(value) ? value : [])
  const isOn = (o: unknown) => ALWAYS_ON.has(o) || picked.has(o)
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
              disabled={disabled || ALWAYS_ON.has(o)}
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
