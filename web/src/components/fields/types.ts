import type { FieldInfo } from "./schema"

/** What every control receives. The shell (label, help, errors) is drawn around it. */
export interface ControlProps {
  f: FieldInfo
  id: string
  value: unknown
  disabled?: boolean
  invalid: boolean
  describedBy?: string
  onChange: (value: unknown) => void
}

/** Shared control chrome: every color is a `--field-*` token via the theme. */
export const CONTROL =
  "h-control w-full min-w-0 rounded-control border border-field-border bg-field px-2 font-mono text-sm text-fg disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger"
