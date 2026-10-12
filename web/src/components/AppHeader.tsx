import { ChevronDown } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { useDemo } from "@/api/useDemo"
import { cn } from "@/lib/utils"
import { LESSONS_ENABLED } from "@/state/lessons"

import { ApiKeyControl } from "./ApiKeyControl"
import { DisplaySettings } from "./ThemeToggle"
import { BrandMark } from "@/components/BrandMark"

const PRIMARY = [
  { href: "/", label: "Home" },
  { href: "/learn", label: "Lessons" },
  { href: "/build", label: "Build" },
  { href: "/compare", label: "Compare" },
  { href: "/evaluate", label: "Evaluate" },
  { href: "/read", label: "Read" },
  { href: "/library", label: "Library" },
]

/** Development pages: real components against real-engine fixtures. */
const DEV = [
  { href: "/inspect", label: "Inspectors" },
  { href: "/design", label: "Design" },
]

/** Paths that count as a dev page, including the design page's old alias. */
const DEV_PATHS = new Set(["/inspect", "/design", "/specimen"])

function NavLink({ href, label, path }: { href: string; label: string; path: string }) {
  // /learn lists the lessons; each lesson has its own page under it.
  const current = path === href || (href === "/learn" && path.startsWith("/learn/"))
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-row-compact items-center rounded-control px-2 text-sm md:px-1 lg:px-2",
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
          "hidden h-row-compact items-center gap-1 rounded-control px-2 text-xs md:order-3 md:flex",
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

export function AppHeader({ path, lessonsEnabled = LESSONS_ENABLED }: { path: string; lessonsEnabled?: boolean }) {
  // The dev pages are for working on the app, not for demo visitors.
  const demo = useDemo()
  // With the lessons hidden, there is no Lessons link. Home is always first.
  const primary = lessonsEnabled ? PRIMARY : PRIMARY.filter((l) => l.href !== "/learn")
  return (
    // Below md: two rows. The brand and the controls share the first, the nav
    // takes the second (wrapping inside its own box at most once). From md up
    // it is one row. No page has a document control up here: each page shows
    // its documents itself. The page never scrolls sideways.
    <header className="flex min-h-row shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-surface px-3 py-1 md:gap-x-3 lg:gap-x-4">
      <a href="/" className="order-1 inline-flex items-center gap-2 text-sm font-semibold whitespace-nowrap text-fg no-underline">
        <BrandMark />
        RAG Playground
      </a>
      <nav className="order-3 flex w-full min-w-0 flex-wrap items-center gap-1 md:order-2 md:w-auto md:gap-0 lg:gap-1" aria-label="Main">
        {primary.map((l) => (
          <NavLink key={l.href} {...l} path={path} />
        ))}
        {/* GitHub is on Home (More and the footer), so the Home tab costs the row no width. */}
      </nav>
      {demo ? null : <DevMenu path={path} />}
      <div
        data-testid="header-controls"
        className="order-2 ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:order-5 md:ml-auto"
      >
        <a
          href="/privacy"
          aria-label="Your data and privacy"
          aria-current={path === "/privacy" ? "page" : undefined}
          className={cn(
            // From xl only: below it the row needs the room. The footer and
            // Library's lead link reach the page at every width.
            "hidden h-row-compact items-center rounded-control px-1 text-sm underline underline-offset-4 whitespace-nowrap xl:flex",
            path === "/privacy" ? "font-semibold text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          Privacy
        </a>
        <ApiKeyControl />
        <DisplaySettings />
      </div>
    </header>
  )
}
