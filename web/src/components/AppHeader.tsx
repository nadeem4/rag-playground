import { ChevronDown } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { cn } from "@/lib/utils"
import { setLearnMode, useLearnMode } from "@/state/learnMode"

import { ApiKeyControl } from "./ApiKeyControl"
import { ThemeToggle } from "./ThemeToggle"

const PRIMARY = [
  { href: "/", label: "Lessons" },
  { href: "/build", label: "Build" },
  { href: "/compare", label: "Compare" },
]

const REPO = "https://github.com/nadeem4/rag-playground"

/** Development pages: real components against real-engine fixtures. */
const DEV = [
  { href: "/inspect", label: "Inspectors" },
  { href: "/design", label: "Design" },
]

/** Paths that count as a dev page, including the design page's old alias. */
const DEV_PATHS = new Set(["/inspect", "/design", "/specimen"])

function NavLink({ href, label, path }: { href: string; label: string; path: string }) {
  // Home lists the lessons; each lesson has its own page under /learn.
  const current = path === href || (href === "/" && path.startsWith("/learn/"))
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
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-3" />
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

/** Learn mode: stage lessons and setting hints on Build. On for a first visit. */
function LearnModeSwitch() {
  const on = useLearnMode()
  return (
    <label className="flex items-center gap-2 text-xs whitespace-nowrap text-fg select-none">
      <input
        type="checkbox"
        role="switch"
        checked={on}
        aria-checked={on}
        onChange={(e) => setLearnMode(e.target.checked)}
        className="size-[14px] [accent-color:var(--text-primary)]"
      />
      Learn mode
    </label>
  )
}

export function AppHeader({ path }: { path: string }) {
  return (
    <header className="flex h-[40px] shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <a href="/" className="text-sm font-semibold whitespace-nowrap text-fg no-underline">
          RAG Playground
        </a>
        <nav className="flex items-center gap-1" aria-label="Main">
          {PRIMARY.map((l) => (
            <NavLink key={l.href} {...l} path={path} />
          ))}
          <a href={REPO} className="flex h-row-compact items-center rounded-control px-2 text-sm text-fg-muted hover:text-fg">
            GitHub
          </a>
        </nav>
        <DevMenu path={path} />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <LearnModeSwitch />
        <ApiKeyControl />
        <ThemeToggle />
      </div>
    </header>
  )
}
