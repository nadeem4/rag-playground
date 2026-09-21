import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Re-themed to the design contract: 4px control radius, no shadow, no ring
// glow, 28px control height, 13px text. `default` is the ONE accent use for a
// primary action (Run); everything else is chrome.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-control border border-transparent font-sans text-sm font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[14px]",
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
        icon: "h-control w-[28px]",
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
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
