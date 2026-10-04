import { useEffect, useRef, useState } from "react"

import type { VariantState } from "@/api/runState"

/**
 * The seconds each recipe of a run has been running, counted by the browser:
 * from the moment this page first saw its variant start, with a one-second
 * tick while `active`. A new `runId` starts every count again. It never reads the server's timestamps, so a gap
 * between the server's clock and the browser's cannot show.
 */
export function useRunClock(variants: VariantState[], active: boolean, runId: string | null = null): (index: number) => number | null {
  const starts = useRef(new Map<number, number>())
  // A new run counts every recipe from its own start again.
  const forRun = useRef(runId)
  if (forRun.current !== runId) {
    forRun.current = runId
    starts.current = new Map()
  }
  for (const v of variants) {
    if (v.index !== null && !starts.current.has(v.index)) starts.current.set(v.index, Date.now())
  }
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  return (index) => {
    const at = starts.current.get(index)
    return at === undefined ? null : Math.max(0, Math.floor((Date.now() - at) / 1000))
  }
}
