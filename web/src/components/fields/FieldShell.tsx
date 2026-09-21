import type { ReactNode } from "react"

import { Label } from "@/components/ui/label"
import type { FieldKind } from "./schema"

/** Ids a control needs to point its `aria-describedby` at the help and error lines. */
export interface FieldIds {
  control: string
  help: string
  error: string
}

export const fieldIds = (base: string): FieldIds => ({
  control: base,
  help: `${base}-help`,
  error: `${base}-error`,
})

/** `aria-describedby` for a control: help and error, only the ones rendered. */
export function describedBy(ids: FieldIds, hasHelp: boolean, errors: string[]) {
  return [hasHelp && ids.help, errors.length > 0 && ids.error].filter(Boolean).join(" ") || undefined
}

/** Descriptions are Python docstrings: render `backticked` names as mono. */
export function Help({ id, text }: { id: string; text: string }) {
  const parts = text.split(/`([^`]+)`/)
  return (
    <p id={id} className="text-xs text-fg-muted">
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="font-mono">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </p>
  )
}

export function Errors({ id, errors }: { id: string; errors: string[] }) {
  if (errors.length === 0) return null
  if (errors.length === 1) {
    return (
      <p id={id} className="text-xs text-danger">
        {errors[0]}
      </p>
    )
  }
  return (
    <div id={id} className="flex flex-col text-xs text-danger">
      {errors.map((e) => (
        <p key={e}>{e}</p>
      ))}
    </div>
  )
}

interface ShellProps {
  kind: FieldKind
  ids: FieldIds
  label: string
  help?: string
  errors: string[]
  /** Right side of the label row: range hint, unset toggle, raw JSON tag. */
  aside?: ReactNode
  children: ReactNode
}

/** Label above, control, help, then errors below. One block per field. */
export function FieldShell({ kind, ids, label, help, errors, aside, children }: ShellProps) {
  return (
    <div data-field-kind={kind} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-[20px] items-center justify-between gap-2">
        <Label htmlFor={ids.control}>{label}</Label>
        {aside ? <div className="flex items-center gap-3">{aside}</div> : null}
      </div>
      {children}
      {help ? <Help id={ids.help} text={help} /> : null}
      <Errors id={ids.error} errors={errors} />
    </div>
  )
}

/** The explicit way to reach `null` on an `Optional[...]` field. */
export function UnsetToggle({ id, isNull, onToggle }: { id: string; isNull: boolean; onToggle: () => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-1 text-xs text-fg-muted select-none">
      <input
        id={id}
        type="checkbox"
        checked={isNull}
        onChange={onToggle}
        className="size-[12px] [accent-color:var(--text-primary)]"
      />
      Unset
    </label>
  )
}
