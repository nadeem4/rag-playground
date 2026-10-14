import type { ReactNode } from "react"

/** Plain copy, no illustration, no fake UI: what is missing and how to get it. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 p-4">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-[48ch] text-sm text-fg-muted">{children}</p>
    </div>
  )
}
