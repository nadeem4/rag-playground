import { X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

/**
 * A step's output on a phone: a sheet over Build, the way Ask opens there,
 * nearly full height so a wide view has room. Its head names the step and its
 * strategy, with a close button; Escape and a tap on the dimmed page close it
 * too. The page behind stays still, and focus goes back to whatever opened it.
 */
export function OutputSheet({ title, sub, onClose, children }: { title: string; sub: ReactNode; onClose: () => void; children: ReactNode }) {
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
      <div data-testid="output-backdrop" aria-hidden="true" className="ask-backdrop fixed inset-0 z-40 bg-(--scrim)" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="output-sheet fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] min-w-0 flex-col rounded-t-[16px] border border-hairline bg-surface shadow-sheet"
      >
        <span aria-hidden="true" className="mx-auto mt-2 h-[4px] w-[40px] shrink-0 rounded-full bg-flat" />
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-hairline py-1 pr-2 pl-3">
          <div className="flex min-w-0 flex-col">
            <h2 id={id} className="text-xl font-semibold">
              {title} output
            </h2>
            {sub ? <p className="m-0 text-xs break-words text-fg-muted">{sub}</p> : null}
          </div>
          <Button ref={closeRef} variant="ghost" size="icon" aria-label="Close the output" title="Close" onClick={onClose}>
            <X aria-hidden strokeWidth={1.75} />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </section>
    </>
  )
}
