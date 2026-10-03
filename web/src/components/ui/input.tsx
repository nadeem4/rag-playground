import * as React from "react"

import { cn } from "@/lib/utils"

// Every color comes from the `--field-*` tokens, contrast-verified once in
// tokens.css. Sans by default, because a field can hold words; a field that
// holds a number, an id or a code name adds `font-mono` itself.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-control w-full min-w-0 rounded-control border border-field-border bg-field px-2 font-sans text-sm text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className
      )}
      {...props}
    />
  )
}

export { Input }
