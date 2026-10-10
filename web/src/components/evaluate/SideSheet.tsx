import { X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

/**
 * Evaluate's one sheet: "How it is scored" and a question's details both open
 * here. On a wide screen it comes in from the right at full height; under
 * 768 px it rises from the bottom, nearly full height, the way a step's output
 * does on Build. The page behind never moves. Escape, a tap on the dimmed page
 * and the close button close it, and focus goes back to whatever opened it.
 */
export function SideSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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
        className="fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] min-w-0 flex-col rounded-t-[16px] border border-hairline bg-surface-raised shadow-sheet md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-[min(30rem,100vw)] md:rounded-none md:border-y-0 md:border-r-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline py-2 pr-2 pl-4">
          <h2 id={id} className="min-w-0 text-base font-semibold break-words text-fg">
            {title}
          </h2>
          <Button ref={closeRef} variant="ghost" size="icon" aria-label="Close" title="Close" onClick={onClose}>
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">{children}</div>
      </section>
    </>
  )
}
