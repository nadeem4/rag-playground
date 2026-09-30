import { useEffect, useState } from "react"

import { api } from "./client"
import type { AppSettings } from "./types"

/**
 * The app settings once they arrive; null before, and when they cannot be read.
 */
export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    let live = true
    api.appSettings().then(
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
