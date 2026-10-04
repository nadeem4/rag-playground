import { useId } from "react"
import { X } from "lucide-react"

import type { TransformInfo, Variant } from "@/api/types"
import { CONTROL } from "@/components/fields/types"
import { transformLabel } from "@/components/pipeline/NodeCard"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import { defaultConfig } from "@/state/graph"

/** The fields' titles in sentence case, in place of the schemas' own ("Chunk Size", "Rrf K"). */
export const RECIPE_TITLES: Record<string, string> = {
  chunk_size: "Chunk size",
  chunk_overlap: "Chunk overlap",
  max_tokens: "Most tokens per piece",
  overlap: "Overlap tokens",
  sentences_per_chunk: "Sentences per piece",
  overlap_sentences: "Overlap sentences",
  top_k: "Candidates, top k",
  rrf_k: "RRF k",
  truncate_dim: "Dimensions",
}

/**
 * One Compare recipe's editor: a strategy and its settings. The strategy is
 * part of the recipe, because comparing two chunkers is a strategy change,
 * not a settings change. `labelFor` names a strategy in the picker.
 */
export function SweepControl({
  variant,
  transforms,
  onChange,
  onRemove,
  labelFor = transformLabel,
}: {
  variant: Variant
  transforms: TransformInfo[]
  onChange: (v: Variant) => void
  onRemove?: () => void
  labelFor?: (name: string) => string
}) {
  const id = useId()
  const info = transforms.find((t) => t.name === variant.transform)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-t`} className="text-sm font-medium">
            Strategy
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
                {labelFor(t.name)}
              </option>
            ))}
          </select>
        </div>
        {onRemove ? (
          <Button variant="ghost" size="icon" aria-label="Remove this recipe" title="Remove this recipe" onClick={onRemove}>
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
      {info ? (
        <SchemaForm key={info.name} schema={info.config_schema} value={variant.config} titles={RECIPE_TITLES} onChange={(config) => onChange({ ...variant, config })} />
      ) : null}
    </div>
  )
}
