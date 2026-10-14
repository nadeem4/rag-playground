import { useId, type ReactNode } from "react"

import { needsApiKey } from "@/api/apiKey"
import type { TransformInfo } from "@/api/types"
import { CONST_TEXT } from "@/components/fields/ConstField"
import { Picker, PickerNote, type PickerOption } from "@/components/ui/Picker"
import { firstSentence } from "@/lib/sentence"
import { compatibility, type Compat } from "@/state/compat"

/**
 * A step's transform picker, shared by the cards and the Ask panel. Every
 * option is judged against the same upstream, so the list tags the ones
 * that would fall back (soft) or could not run (hard, disabled) before they
 * are picked, and the reason for the current pick shows under it. Each option
 * says what it does in one line: the first sentence of its summary.
 */

export interface TransformSelectProps {
  id: string
  label: string
  transforms: TransformInfo[]
  value: string
  /** The transform wired into each input port of the step. */
  upstream: Record<string, TransformInfo | undefined>
  /** The option's plain name. Defaults to the transform's own name. */
  labelFor?: (name: string) => string
  /** The info button beside the label (FieldHelp), as every field has. */
  info?: ReactNode
  /** `hasAnyKey`: only `false` tags the strategies that need a key. */
  hasKey?: boolean | null
  onChange: (transform: string) => void
}

/** The lock state of `value` behind `upstream`: what the picker shows under itself. */
export function lockOf(transforms: TransformInfo[], value: string, upstream: Record<string, TransformInfo | undefined>): Compat {
  const info = transforms.find((t) => t.name === value)
  return info ? compatibility(info, upstream) : { kind: "ok" }
}

export function TransformSelect({ id, label, transforms, value, upstream, labelFor = (n) => n, info, hasKey = null, onChange }: TransformSelectProps) {
  const labelId = useId()
  const options: PickerOption[] = transforms.map((t) => {
    const lock = compatibility(t, upstream)
    return {
      value: t.name,
      name: labelFor(t.name),
      code: t.name,
      help: t.summary ? firstSentence(t.summary) : undefined,
      lock: lock.kind === "ok" ? undefined : lock,
      needsKey: hasKey === false && needsApiKey(t.name),
    }
  })
  const current = options.find((o) => o.value === value)
  return (
    <>
      <div className="flex min-h-[20px] min-w-0 items-center gap-1">
        <label id={labelId} htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {info}
      </div>
      {transforms.length === 1 ? (
        // One registered transform: nothing to choose, so no picker.
        <>
          <output id={id} className={CONST_TEXT}>
            {current && current.name !== current.code ? `${current.name}, ${current.code}` : value}
          </output>
          <PickerNote option={current} />
        </>
      ) : (
        <Picker id={id} labelledBy={labelId} options={options} value={value} onChange={onChange} />
      )}
    </>
  )
}
