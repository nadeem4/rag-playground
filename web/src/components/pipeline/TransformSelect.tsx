import type { TransformInfo } from "@/api/types"
import { CONST_TEXT } from "@/components/fields/ConstField"
import { CONTROL } from "@/components/fields/types"
import { compatibility, optionLabel, type Compat } from "@/state/compat"

/**
 * A step's transform picker, shared by the cards and the Ask panel. Every
 * option is judged against the same upstream, so the dropdown tags the ones
 * that would fall back (soft) or could not run (hard, disabled) before they
 * are picked, and the reason for the current pick shows under it.
 */

export interface TransformSelectProps {
  id: string
  label: string
  transforms: TransformInfo[]
  value: string
  /** The transform wired into each input port of the step. */
  upstream: Record<string, TransformInfo | undefined>
  /** The option's shown name. Defaults to the transform's own name. */
  labelFor?: (name: string) => string
  onChange: (transform: string) => void
}

/** The lock state of `value` behind `upstream`: what the select shows under itself. */
export function lockOf(transforms: TransformInfo[], value: string, upstream: Record<string, TransformInfo | undefined>): Compat {
  const info = transforms.find((t) => t.name === value)
  return info ? compatibility(info, upstream) : { kind: "ok" }
}

export function TransformSelect({ id, label, transforms, value, upstream, labelFor = (n) => n, onChange }: TransformSelectProps) {
  const compat: Record<string, Compat> = Object.fromEntries(transforms.map((t) => [t.name, compatibility(t, upstream)]))
  const lock = compat[value] ?? { kind: "ok" }
  return (
    <>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {transforms.length === 1 ? (
        // One registered transform: nothing to choose, so no picker.
        <output id={id} className={CONST_TEXT}>
          {labelFor(value)}
        </output>
      ) : (
        <select id={id} className={CONTROL} value={value} onChange={(e) => onChange(e.target.value)}>
          {transforms.map((t) => (
            <option key={t.name} value={t.name} disabled={compat[t.name]?.kind === "hard"}>
              {optionLabel(labelFor(t.name), compat[t.name] ?? { kind: "ok" })}
            </option>
          ))}
        </select>
      )}
      {lock.kind === "soft" ? (
        <p role="status" data-testid="lock-reason" className="text-xs leading-[1.5] break-words text-fg-muted">
          {lock.reason}
        </p>
      ) : lock.kind === "hard" ? (
        <p role="alert" data-testid="lock-reason" className="text-xs leading-[1.5] break-words text-danger">
          {lock.reason}
        </p>
      ) : null}
    </>
  )
}
