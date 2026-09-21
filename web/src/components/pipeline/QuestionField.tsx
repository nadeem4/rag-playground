import { useId } from "react"

import { Errors } from "@/components/fields/FieldShell"

/**
 * The Ask card's question. It is what a user changes most, so it is a real
 * multi-line box rather than a schema field, and Ctrl+Enter (Cmd+Enter on a
 * Mac) asks it: the same as the card's Run, straight through to the end.
 */
export function QuestionField({
  value,
  errors = [],
  disabled,
  onChange,
  onSubmit,
}: {
  value: string
  errors?: string[]
  disabled?: boolean
  onChange: (text: string) => void
  onSubmit: () => void
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
      <p id={`${id}-help`} className="text-xs text-fg-muted">
        Ctrl+Enter asks it.
      </p>
      <Errors id={errorId} errors={errors} />
    </div>
  )
}
