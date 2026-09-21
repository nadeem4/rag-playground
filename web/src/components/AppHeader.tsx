import { cn } from "@/lib/utils"

import { ApiKeyControl } from "./ApiKeyControl"
import { ThemeToggle } from "./ThemeToggle"

const PRIMARY = [
  { href: "/", label: "Build" },
  { href: "/compare", label: "Compare" },
]

/** Development galleries: real components against real-engine fixtures. */
const GALLERIES = [
  { href: "/forms", label: "Forms" },
  { href: "/inspect", label: "Inspectors" },
  { href: "/specimen", label: "Tokens" },
]

function NavLink({ href, label, path, quiet }: { href: string; label: string; path: string; quiet?: boolean }) {
  const current = path === href
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-row-compact items-center rounded-control px-2",
        quiet ? "text-xs" : "text-sm",
        current ? "bg-muted text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </a>
  )
}

export function AppHeader({ path }: { path: string }) {
  return (
    <header className="flex h-[40px] shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <span className="text-sm font-semibold whitespace-nowrap">RAG Playground</span>
        <nav className="flex items-center gap-1" aria-label="Main">
          {PRIMARY.map((l) => (
            <NavLink key={l.href} {...l} path={path} />
          ))}
        </nav>
        <nav className="hidden items-center gap-1 border-l border-hairline pl-2 md:flex" aria-label="Development galleries">
          {GALLERIES.map((l) => (
            <NavLink key={l.href} {...l} path={path} quiet />
          ))}
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ApiKeyControl />
        <ThemeToggle />
      </div>
    </header>
  )
}
