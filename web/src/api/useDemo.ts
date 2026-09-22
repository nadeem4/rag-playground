import { useEffect, useState } from "react"

import { api } from "./client"

/**
 * Is this a hosted demo (`GET /api/settings/app`)? False until the answer
 * arrives, and false if it cannot be read: the server refuses uploads in demo
 * mode anyway, so hiding Upload is only a courtesy.
 */
export function useDemo(): boolean {
  const [demo, setDemo] = useState(false)
  useEffect(() => {
    let live = true
    api.appSettings().then(
      (s) => live && setDemo(s?.demo === true),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return demo
}
