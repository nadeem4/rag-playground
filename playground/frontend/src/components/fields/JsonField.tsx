import { useState } from "react"

import type { ControlProps } from "./types"

const show = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2))

/**
 * The escape hatch for shapes the renderer has no control for. Uncontrolled
 * while typing, because half-typed JSON is not a value; each parseable edit is
 * emitted, and an unparseable one keeps the last good value.
 */
export function JsonField({ id, value, disabled, invalid, describedBy, onChange }: ControlProps) {
  const [parseError, setParseError] = useState(false)
  const text = show(value)
  return (
    <>
      <textarea
        id={id}
        defaultValue={text}
        rows={Math.min(8, Math.max(3, text.split("\n").length))}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid || parseError || undefined}
        aria-describedby={[describedBy, parseError && `${id}-parse`].filter(Boolean).join(" ") || undefined}
        className="w-full min-w-0 rounded-control border border-field-border bg-field px-2 py-1 font-mono text-xs text-fg aria-invalid:border-danger"
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
            setParseError(false)
          } catch {
            setParseError(true)
          }
        }}
      />
      {parseError ? (
        <p id={`${id}-parse`} className="text-xs text-danger">
          Not valid JSON. The last valid value is kept.
        </p>
      ) : null}
    </>
  )
}
