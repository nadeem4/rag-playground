import { useEffect, useState } from "react"

import { api } from "./client"
import type { AppSettings } from "./types"

/**
 * One `GET /api/settings/app` for the whole page: every caller shares this
 * promise. A failure clears it, so a later mount asks again.
 */
let cached: Promise<AppSettings> | null = null

function appSettings(): Promise<AppSettings> {
  if (!cached) {
    const p = api.appSettings()
    cached = p
    p.catch(() => {
      if (cached === p) cached = null
    })
  }
  return cached
}

/** Forget the shared answer, so each test can serve its own settings. */
export function resetAppSettingsForTests() {
  cached = null
}

/**
 * The app settings once they arrive; null before, and when they cannot be read.
 */
export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    let live = true
    appSettings().then(
      (s) => live && setSettings(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return settings
}

/**
 * Is this a hosted demo (`GET /api/settings/app`)? False until the answer
 * arrives, and false if it cannot be read.
 */
export function useDemo(): boolean {
  return useAppSettings()?.demo === true
}
