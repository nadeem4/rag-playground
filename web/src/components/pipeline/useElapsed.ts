import { useEffect, useState } from "react"

/**
 * Whole seconds since `startedAt` (epoch seconds), ticking once a second while
 * `startedAt` is set. Feedback for a long parse, not decoration: no animation.
 * The running card, the run strip and the Ask panel's status line share it.
 */
export function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [startedAt])
  if (startedAt === undefined) return undefined
  return Math.max(0, Math.floor(now / 1000 - startedAt))
}
