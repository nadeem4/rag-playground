import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import type { ControlProps } from "./types"

/**
 * A list of plain strings: one input per entry, with a row to add and a button
 * to drop one. Without it a `list[str]` falls through to the raw JSON textarea,
 * which asks a reader to get quoting and commas right to type one sentence.
 *
 * An entry left blank is emitted as it stands rather than dropped here, because
 * dropping it would delete the row the reader is about to type into. The engine
 * trims and drops blanks when it resolves the value, in one place, so nothing
 * downstream sees an empty entry.
 */
export function StringListField({ f, id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const current = Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : String(v ?? ""))) : []
  // An empty list still shows one row, so there is somewhere to type.
  const rows = current.length > 0 ? current : [""]
  const label = f.schema.title ?? "list"

  const emit = (next: string[]) => onChange(next)

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className="flex min-w-0 items-center gap-1">
          <Input
            id={i === 0 ? id : `${id}-${i}`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label={`${label} ${i + 1}`}
            value={row}
            disabled={disabled}
            aria-invalid={(i === 0 && invalid) || undefined}
            aria-describedby={i === 0 ? describedBy : undefined}
            onChange={(e) => emit(rows.map((r, j) => (j === i ? e.target.value : r)))}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={`Remove from ${label}`}
            disabled={disabled || (rows.length === 1 && row === "")}
            onClick={() => emit(rows.filter((_, j) => j !== i))}
          >
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="self-start"
        aria-label={`Add to ${label}`}
        disabled={disabled}
        onClick={() => emit([...rows, ""])}
      >
        <Plus aria-hidden strokeWidth={1.75} />
        Add
      </Button>
    </div>
  )
}
