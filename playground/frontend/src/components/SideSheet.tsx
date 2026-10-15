import { X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

/**
 * The app's side sheet: Evaluate's "How it is scored" and a question's
 * details, and a document's Preview, all open here. On a wide screen it comes in from the right at full height; under
 * 768 px it rises from the bottom, nearly full height, the way a step's output
 * does on Build. The page behind never moves. Escape, a tap on the dimmed page
 * and the close button close it, and focus goes back to whatever opened it.
 */
export function SideSheet({
  title,
  onClose,
  children,
  footer,
  head,
  wide = false,
  medium = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** More of the header under the title, such as a document's facts and page jump. */
  head?: ReactNode
  /** Room for two sets of cards, such as the template picker: up to 72rem on a wide screen. */
  wide?: boolean
  /** Room for two columns side by side, such as Take it home: up to 48rem on a wide screen. */
  medium?: boolean
}) {
  const id = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      if (back?.isConnected) back.focus()
    }
  }, [])

  useEffect(() => {
    const boxes = [document.documentElement, document.body]
    const before = boxes.map((el) => el.style.overflow)
    boxes.forEach((el) => (el.style.overflow = "hidden"))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      boxes.forEach((el, i) => (el.style.overflow = before[i]))
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  return (
    <>
      <div data-testid="sheet-backdrop" aria-hidden="true" className="ask-backdrop fixed inset-0 z-40 bg-(--scrim)" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        data-testid="side-sheet"
        className={`fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] min-w-0 flex-col rounded-t-[16px] border border-hairline bg-surface-raised shadow-sheet md:inset-y-0 md:right-0 md:left-auto md:h-auto ${wide ? "md:w-[min(72rem,100vw)]" : medium ? "md:w-[min(48rem,100vw)]" : "md:w-[min(30rem,100vw)]"} md:rounded-none md:border-y-0 md:border-r-0`}
      >
        <div className="flex shrink-0 flex-col gap-1 border-b border-hairline py-2 pr-2 pl-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id={id} className="min-w-0 text-base font-semibold break-words text-fg">
              {title}
            </h2>
            <Button ref={closeRef} variant="ghost" size="icon" aria-label="Close" title="Close" onClick={onClose}>
              <X aria-hidden strokeWidth={1.75} />
            </Button>
          </div>
          {head ? <div className="flex min-w-0 flex-col gap-2 pr-2 pb-1">{head}</div> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">{children}</div>
        {/* The sheet's actions stay in view under the scrolling body. */}
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-hairline px-4 py-3">{footer}</div>
        ) : null}
      </section>
    </>
  )
}
