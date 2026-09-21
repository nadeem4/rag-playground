import { useId } from "react"
import { X } from "lucide-react"

import type { TransformInfo, Variant } from "@/api/types"
import { CONTROL } from "@/components/fields/types"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { defaultConfig } from "@/state/graph"

/**
 * One sweep variant: a transform and its config. The transform is part of the
 * variant, because comparing two chunkers is a transform change, not a config
 * change.
 */
export function SweepControl({
  variant,
  transforms,
  onChange,
  onRemove,
  changed,
}: {
  variant: Variant
  transforms: TransformInfo[]
  onChange: (v: Variant) => void
  onRemove?: () => void
  /** The variant was edited after the sweep that produced the result below it. */
  changed?: boolean
}) {
  const id = useId()
  const info = transforms.find((t) => t.name === variant.transform)
  return (
    <div className="flex min-w-0 flex-col gap-3 bg-surface p-3">
      <div className="flex min-w-0 items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-t`} className="text-sm font-medium">
            Transform
          </label>
          <select
            id={`${id}-t`}
            className={CONTROL}
            value={variant.transform}
            onChange={(e) => {
              const next = transforms.find((t) => t.name === e.target.value)
              if (next) onChange({ transform: next.name, config: defaultConfig(next) })
            }}
          >
            {transforms.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {onRemove ? (
          <Button variant="ghost" size="icon" aria-label={`Remove variant ${variant.transform}`} title="Remove this variant" onClick={onRemove}>
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
      {info ? (
        <SchemaForm key={info.name} schema={info.config_schema} value={variant.config} onChange={(config) => onChange({ ...variant, config })} />
      ) : null}
      {changed ? <p className="text-xs text-fg-muted">Edited since the last sweep. Run the sweep again to update the result below.</p> : null}
    </div>
  )
}
