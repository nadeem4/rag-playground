import { PanelLeft, PanelRight, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { PanelWide } from "./useWide"

/**
 * The Ask panel's dock on Build: a column at the right (or left) edge that the
 * main pane shrinks to make room for, with a resize edge, a side switch and a
 * close button. Closed, a round Ask button sits at the bottom right. Below lg
 * it is a bottom sheet over the page instead. The panel inside is never
 * unmounted: closing only hides it, so the question and results are kept.
 */

/** Where the side, the width and open or closed are remembered in this browser. */
export const DOCK_KEY = "rag-playground:ask-dock:v1"
/** Below lg: the panel is a bottom sheet; the dock exists from lg up. */
export const SHEET_QUERY = "(max-width: 63.99rem)"
/** lg and up: a first visit opens the panel. */
export const DESKTOP_QUERY = "(min-width: 64rem)"

export const DOCK_MIN = 320
export const DOCK_MAX = 960
const DEFAULT_WIDTH = 440
/** The pipeline column's width and the main pane's least width, which the panel never takes. */
const COLUMN = 380
const MAIN_MIN = 360
/** The two 1 px gaps between the three columns. */
const GAPS = 2
/** The comparison sets its lists side by side from this panel width. */
const WIDE_FROM = 640

const CLOSE_LABEL = "Close Ask. Your question and results are kept."

export type DockSide = "left" | "right"

export interface Dock {
  open: boolean
  /** Below lg: the panel is a bottom sheet. */
  sheet: boolean
  side: DockSide
  width: number
  setOpen: (open: boolean) => void
  setSide: (side: DockSide) => void
  setWidth: (width: number) => void
}

function matches(query: string, fallback: boolean): boolean {
  return typeof matchMedia === "function" ? matchMedia(query).matches : fallback
}

const between = (w: number, min: number, max: number) => Math.max(min, Math.min(max, w))

/** The stored record, each field checked; anything unreadable is left out. */
function readStored(): { open?: boolean; side?: DockSide; width?: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_KEY) ?? "null") as Record<string, unknown> | null
    if (!raw || typeof raw !== "object") return {}
    return {
      open: typeof raw.open === "boolean" ? raw.open : undefined,
      side: raw.side === "left" || raw.side === "right" ? raw.side : undefined,
      width: typeof raw.width === "number" && Number.isFinite(raw.width) ? between(Math.round(raw.width), DOCK_MIN, DOCK_MAX) : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * The dock's state, read once from this browser and saved as it changes. A
 * first visit opens it from lg up. Open or closed is kept apart for the dock
 * and the sheet: only the dock's is remembered, so a visit below lg never
 * changes it, and the sheet always starts closed, so a page never loads
 * behind a sheet. When the window drops below lg an open dock becomes a
 * closed sheet; back at lg the dock is as it was left.
 */
export function useAskDock(): Dock {
  const sheet = useSheet()
  const [initial] = useState(() => {
    const s = readStored()
    return {
      open: s.open ?? matches(DESKTOP_QUERY, true),
      side: s.side ?? "right",
      width: s.width ?? DEFAULT_WIDTH,
    }
  })
  const [dockOpen, setDockOpen] = useState(initial.open)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [side, setSide] = useState<DockSide>(initial.side)
  const [width, setWidth] = useState(initial.width)
  // Leaving the sheet closes it, so the next time the window drops below lg it starts closed.
  useEffect(() => {
    if (!sheet) setSheetOpen(false)
  }, [sheet])
  useEffect(() => {
    try {
      window.localStorage.setItem(DOCK_KEY, JSON.stringify({ open: dockOpen, side, width }))
    } catch {
      // Storage is blocked: the dock still works, it is only not remembered.
    }
  }, [dockOpen, side, width])
  const setOpen = useCallback((next: boolean) => (sheet ? setSheetOpen(next) : setDockOpen(next)), [sheet])
  return { open: sheet ? sheetOpen : dockOpen, sheet, side, width, setOpen, setSide, setWidth }
}

function subscribeSheet(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {}
  const mq = matchMedia(SHEET_QUERY)
  mq.addEventListener?.("change", onChange)
  return () => mq.removeEventListener?.("change", onChange)
}

/** Whether the window is below lg, kept current as it resizes. */
function useSheet(): boolean {
  return useSyncExternalStore(subscribeSheet, () => matches(SHEET_QUERY, false))
}

/** The element's width, kept current; null without `ResizeObserver` (jsdom). */
function usePanelWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver !== "function") return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width
      if (typeof w === "number") setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** What Tab can reach inside `root`: its controls and disclosures, leaving out what is not drawn (inside a closed disclosure, say). */
function tabbable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`${FOCUSABLE}, summary`)].filter((el) => el.checkVisibility?.() ?? el.offsetParent !== null)
}

/** A place where Alt+A may be typing: a field, a select or editable text. */
function isField(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.closest('[contenteditable=""], [contenteditable="true"]') !== null
}

export function AskDock({
  dock,
  count,
  measure,
  children,
}: {
  dock: Dock
  /** How many results the last question found; shown on the round button once a question has been asked. */
  count?: number
  /** Build's width in px, so the panel never leaves the main pane under 360 px. */
  measure: () => number
  /** The Ask panel, given the head's buttons to show beside its title. */
  children: (head: ReactNode) => ReactNode
}) {
  const { open, sheet, side, width, setOpen, setSide, setWidth } = dock
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const fabRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the panel has opened or closed: set only by the reader's own action.
  const focusNext = useRef<"question" | "button" | null>(null)
  const panelWidth = usePanelWidth(aside)

  const show = useCallback(() => {
    focusNext.current = "question"
    setOpen(true)
  }, [setOpen])
  const hide = useCallback(() => {
    focusNext.current = "button"
    setOpen(false)
  }, [setOpen])

  useLayoutEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (next === "button") fabRef.current?.focus()
    else if (next === "question") (aside?.querySelector<HTMLElement>("textarea") ?? aside?.querySelector<HTMLElement>(FOCUSABLE))?.focus()
  }, [open, aside])

  // While the sheet is open the page behind it stays still: the document and
  // Build's own scroll box stop scrolling, and get their own values back on close.
  const locked = sheet && open
  useEffect(() => {
    if (!locked) return
    const boxes = [document.documentElement, document.body, aside?.parentElement].filter((el): el is HTMLElement => Boolean(el))
    const before = boxes.map((el) => el.style.overflow)
    boxes.forEach((el) => (el.style.overflow = "hidden"))
    return () => boxes.forEach((el, i) => (el.style.overflow = before[i]))
  }, [locked, aside])

  // Alt+A opens and closes the panel from anywhere on Build, once per press. It
  // leaves a field alone, except the question box; there only the a key counts,
  // so Option+A still types å on a Mac. Elsewhere the key code, so it works there too.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return
      const inQuestion = e.target !== null && e.target === aside?.querySelector("textarea")
      if (isField(e.target) && !inQuestion) return
      const isA = inQuestion ? e.key === "a" || e.key === "A" : e.code === "KeyA" || e.key.toLowerCase() === "a"
      if (!isA) return
      e.preventDefault()
      if (open) hide()
      else show()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, show, hide, aside])

  // The sheet is modal: focus that gets out is brought back to its first control.
  useEffect(() => {
    if (!locked || !aside) return
    const onFocus = (e: FocusEvent) => {
      if (aside.hidden || aside.contains(e.target as Node)) return
      tabbable(aside)[0]?.focus()
    }
    document.addEventListener("focusin", onFocus)
    return () => document.removeEventListener("focusin", onFocus)
  }, [locked, aside])

  // Build's width, kept current as the window resizes: what the panel may take depends on it.
  const [buildWidth, setBuildWidth] = useState(measure)
  useLayoutEffect(() => {
    const update = () => setBuildWidth(measure())
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [measure])
  // The most the panel may take, and the width it shows. A narrow window narrows what is
  // shown, never what is stored: widen the window and the stored width comes back.
  const most = Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(buildWidth) - COLUMN - MAIN_MIN - GAPS))
  const shown = between(width, DOCK_MIN, most)
  const clamp = (w: number) => between(Math.round(w), DOCK_MIN, most)
  // Only a change the reader can see is stored, so a larger stored width survives a narrow window.
  const resize = (next: number) => {
    if (next !== shown) setWidth(next)
  }

  // The sheet is modal: Escape closes it, and Tab stays inside it.
  function onSheetKey(e: KeyboardEvent<HTMLElement>) {
    if (!sheet || !aside) return
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault()
      hide()
      return
    }
    if (e.key !== "Tab") return
    const all = tabbable(aside)
    if (!all.length) return
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (at === -1) {
      e.preventDefault()
      ;(e.shiftKey ? all[all.length - 1] : all[0]).focus()
    } else if (e.shiftKey && at === 0) {
      e.preventDefault()
      all[all.length - 1].focus()
    } else if (!e.shiftKey && at === all.length - 1) {
      e.preventDefault()
      all[0].focus()
    }
  }

  // The edge is the panel's inner side: on the right, moving it left widens the panel.
  const dir = side === "right" ? 1 : -1
  function onEdgeKey(e: KeyboardEvent<HTMLElement>) {
    const step = e.shiftKey ? 80 : 20
    if (e.key === "ArrowLeft") resize(clamp(shown + step * dir))
    else if (e.key === "ArrowRight") resize(clamp(shown - step * dir))
    else if (e.key === "Home") resize(DOCK_MIN)
    else if (e.key === "End") resize(most)
    else return
    e.preventDefault()
  }

  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  function onEdgeDown(e: PointerEvent<HTMLElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    drag.current = { id: e.pointerId, x: e.clientX, width: shown }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
  }
  function onEdgeMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    resize(clamp(d.width + (d.x - e.clientX) * dir))
  }
  function onEdgeUp(e: PointerEvent<HTMLElement>) {
    if (!drag.current || drag.current.id !== e.pointerId) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
  }

  const other = side === "right" ? "left" : "right"
  const head = (
    <div className="flex shrink-0 items-center gap-1">
      {sheet ? null : (
        <Button variant="ghost" size="icon" aria-label={`Move the panel to the ${other}`} title={`Move to the ${other}`} onClick={() => setSide(other)}>
          {side === "right" ? <PanelLeft aria-hidden /> : <PanelRight aria-hidden />}
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label={CLOSE_LABEL} title="Close (Alt+A)" onClick={hide}>
        <X aria-hidden />
      </Button>
    </div>
  )

  return (
    <>
      {sheet && open ? (
        <div data-testid="ask-backdrop" aria-hidden="true" className="ask-backdrop fixed inset-0 z-40 bg-(--scrim)" onClick={hide} />
      ) : null}
      <aside
        id="ask-dock"
        ref={setAside}
        role={sheet ? "dialog" : "complementary"}
        aria-modal={sheet ? true : undefined}
        aria-label="Ask"
        data-side={side}
        hidden={!open}
        onKeyDown={onSheetKey}
        className={cn(
          "ask-dock @container fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] min-w-0 flex-col rounded-t-[16px] border border-hairline bg-surface shadow-sheet",
          "lg:relative lg:inset-x-auto lg:bottom-auto lg:z-auto lg:h-auto lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none",
          side === "left" && "lg:order-first",
        )}
      >
        {sheet ? <span data-grab aria-hidden="true" className="mx-auto mt-2 h-[4px] w-[40px] shrink-0 rounded-full bg-flat" /> : null}
        {sheet ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the Ask panel"
            aria-valuemin={DOCK_MIN}
            aria-valuemax={most}
            aria-valuenow={shown}
            tabIndex={0}
            data-dragging={dragging || undefined}
            className="ask-edge"
            onKeyDown={onEdgeKey}
            onPointerDown={onEdgeDown}
            onPointerMove={onEdgeMove}
            onPointerUp={onEdgeUp}
            onPointerCancel={onEdgeUp}
          />
        )}
        <PanelWide.Provider value={panelWidth === null ? null : panelWidth >= WIDE_FROM}>{children(head)}</PanelWide.Provider>
      </aside>
      <button
        ref={fabRef}
        type="button"
        hidden={open}
        aria-expanded={false}
        aria-controls="ask-dock"
        title="Open Ask (Alt+A)"
        onClick={show}
        className="ask-fab fixed right-4 bottom-4 z-40 inline-flex min-h-[48px] items-center gap-2 rounded-full bg-primary pr-4 pl-3 text-sm font-semibold text-primary-foreground shadow-sheet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
      >
        Ask
        {count !== undefined ? (
          <>
            {" "}
            <span className="rounded-full bg-[color-mix(in_oklab,var(--accent-fg)_22%,transparent)] px-2 font-mono text-xs">
              {count} {count === 1 ? "result" : "results"}
            </span>
          </>
        ) : null}
      </button>
    </>
  )
}
