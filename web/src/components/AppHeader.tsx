import { cn } from "@/lib/utils"

import { ThemeToggle } from "./ThemeToggle"

const LINKS = [
  { href: "/", label: "Pipeline" },
  { href: "/specimen", label: "Tokens" },
]

export function AppHeader({ path }: { path: string }) {
  return (
    <header className="flex h-[40px] shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <span className="text-sm font-semibold whitespace-nowrap">RAG Playground</span>
        <nav className="flex items-center gap-1" aria-label="Main">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
              className={cn(
                "flex h-row-compact items-center rounded-control px-2 text-sm",
                path === l.href ? "bg-muted text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
      <ThemeToggle />
    </header>
  )
}
