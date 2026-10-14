import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Re-themed to the design contract: the control radius, no shadow, the compact
// row height and the workhorse text size, all from tokens.css. `default` is the
// ONE accent use for a primary action (Build the index, Ask); everything else
// is chrome.
//
// One set of states for every button: hover tints and press scales to 0.98,
// both over --dur-fast (only colour, background, border, opacity and the
// scale transform move); focus-visible is a 2px --focus-ring outline with a
// 2px offset; disabled is half opacity with no pointer events. `busy` is disabled
// too, and keeps the label the caller gives it (Building, Asking): no spinner.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-control border border-transparent font-sans text-sm font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,opacity,transform,scale] duration-(--dur-fast) ease-(--ease-in) active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[14px]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        outline: "border-hairline bg-surface text-fg hover:bg-muted",
        ghost: "text-fg hover:bg-muted",
      },
      size: {
        default: "h-control px-3",
        sm: "h-row-compact px-2 text-xs",
        icon: "h-control w-(--row-compact)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  busy = false,
  disabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** A run this button started is in flight: disabled, with the caller's label kept. */
    busy?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
