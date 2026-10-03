import { useId, type ReactNode } from "react"

import { Errors } from "@/components/fields/FieldShell"

/**
 * The Ask panel's question box. It is what a user changes most, so it is a
 * real multi-line box rather than a schema field, and Ctrl+Enter (Cmd+Enter on
 * a Mac) asks it: the same as pressing Ask.
 * `action` (the Ask button) sits right-aligned on the hint's row, so the box
 * and its action read as one group.
 */
export function QuestionField({
  value,
  errors = [],
  disabled,
  onChange,
  onSubmit,
  action,
}: {
  value: string
  errors?: string[]
  disabled?: boolean
  onChange: (text: string) => void
  onSubmit: () => void
  action?: ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className="flex min-w-0 flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <label htmlFor={id} className="text-sm font-medium">
        Question
      </label>
      <textarea
        id={id}
        rows={3}
        value={value}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={`${id}-help${errors.length ? ` ${errorId}` : ""}`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !disabled) {
            e.preventDefault()
            onSubmit()
          }
        }}
        className="w-full min-w-0 resize-y rounded-control border border-field-border bg-field px-2 py-1 text-sm leading-5 text-fg aria-invalid:border-danger"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-help`} className="text-xs text-fg-muted">
          Ctrl+Enter asks it.
        </p>
        {action}
      </div>
      <Errors id={errorId} errors={errors} />
    </div>
  )
}
