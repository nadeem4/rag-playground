import { ChevronDown } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { cn } from "@/lib/utils"

import { ApiKeyControl } from "./ApiKeyControl"
import { ThemeToggle } from "./ThemeToggle"

const PRIMARY = [
  { href: "/", label: "Build" },
  { href: "/compare", label: "Compare" },
]

/** Development pages: real components against real-engine fixtures. */
const DEV = [
  { href: "/inspect", label: "Inspectors" },
  { href: "/design", label: "Design" },
]

/** Paths that count as a dev page, including the design page's old alias. */
const DEV_PATHS = new Set(["/inspect", "/design", "/specimen"])

function NavLink({ href, label, path }: { href: string; label: string; path: string }) {
  const current = path === href
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-row-compact items-center rounded-control px-2 text-sm",
        current ? "bg-muted text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </a>
  )
}

/** A quiet menu for the dev pages, so the primary nav holds only what users need. */
function DevMenu({ path }: { path: string }) {
  const onDevPage = DEV_PATHS.has(path)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        data-current={onDevPage ? "true" : undefined}
        className={cn(
          // Hidden on narrow screens, as the dev galleries always were.
          "hidden h-row-compact items-center gap-1 rounded-control px-2 text-xs md:flex",
          onDevPage ? "bg-muted text-fg" : "text-fg-muted hover:text-fg data-[state=open]:text-fg",
        )}
      >
        Dev
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-10 flex min-w-[140px] flex-col rounded-panel border border-hairline bg-surface-elevated p-1 text-fg"
        >
          {DEV.map((l) => {
            const current = path === l.href || (l.href === "/design" && path === "/specimen")
            return (
              <DropdownMenu.Item key={l.href} asChild>
                <a
                  href={l.href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex h-row-compact items-center rounded-control px-2 text-sm outline-none",
                    "data-[highlighted]:bg-muted data-[highlighted]:text-fg",
                    current ? "text-fg" : "text-fg-muted",
                  )}
                >
                  {l.label}
                </a>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
        <DevMenu path={path} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ApiKeyControl />
        <ThemeToggle />
      </div>
    </header>
  )
}
