import { ChevronDown, Info } from "lucide-react"
import { DropdownMenu, Popover } from "radix-ui"

import { Button } from "@/components/ui/button"
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

/**
 * Learn mode: stage lessons and setting hints on the Build cards, and the
 * "What you are seeing" summary under the Chunk output. It changes nothing
 * anywhere else, so it is shown on Build and nowhere else. On for a first
 * visit, and the stored choice is the same one it always was.
 */
function LearnModeSwitch() {
  const on = useLearnMode()
  return (
    <div className="flex items-center gap-1">
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
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="What Learn mode does" title="What Learn mode does">
            <Info aria-hidden strokeWidth={1.75} className="size-[16px]" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={16}
            aria-label="About Learn mode"
            className="z-10 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-panel border border-fg-muted bg-surface p-3 text-fg"
          >
            <h3 className="m-0 text-sm font-semibold">Learn mode</h3>
            <p className="m-0 text-sm leading-[1.55] text-fg-muted">
              Learn mode adds a short explanation under every setting on this page, and a summary of what each step did. Turn it off for a clean
              workbench.
            </p>
            <p className="m-0 text-sm leading-[1.55] text-fg-muted">It changes this page only. The lessons read the same either way.</p>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

export function AppHeader({ path }: { path: string }) {
  return (
    // Wraps to a second row on a phone, so the page itself never scrolls sideways.
    <header className="flex min-h-[40px] shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-hairline bg-surface px-3 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:gap-x-4">
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
        {path === "/build" ? <LearnModeSwitch /> : null}
        <ApiKeyControl />
        <ThemeToggle />
      </div>
    </header>
  )
}
