import type { ControlProps } from "./types"

/** Mono text for a value that offers no choice. `<output>` so the label still points at it. */
export const CONST_TEXT = "block min-w-0 font-mono text-sm break-all text-fg"

/**
 * A `Literal` with a single value (`const`, or a one-member `enum`): there is
 * nothing to choose, so it is shown as text rather than a one-option select.
 * The form still emits the value; this component never changes it.
 */
export function ConstField({ f, id, value, disabled, describedBy }: ControlProps) {
  const shown = disabled ? "unset" : String(value ?? f.options[0])
  return (
    <output id={id} aria-describedby={describedBy} className={disabled ? `${CONST_TEXT} text-fg-muted` : CONST_TEXT}>
      {shown}
    </output>
  )
}
