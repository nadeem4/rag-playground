import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

import type { LlmCheck, LlmServerSource } from "./types"

/**
 * The Anthropic API key typed in the UI (plan I-8).
 *
 * It lives in React state inside this provider and NOWHERE else: never
 * localStorage, sessionStorage or IndexedDB, never the URL, never the stored
 * graph or a node config, never the console. A reload drops it. The client
 * sends it as a header on runs, sweeps and the key check, and only when set.
 */

export interface ApiKeyState {
  /** The UI key, or null when none is set. */
  key: string | null
  setKey: (key: string | null) => void
  /** The header panel, open or closed; other parts of the page can open it. */
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
}

const NONE: ApiKeyState = { key: null, setKey: () => {}, panelOpen: false, setPanelOpen: () => {} }

const ApiKeyContext = createContext<ApiKeyState>(NONE)

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const value = useMemo(() => ({ key, setKey, panelOpen, setPanelOpen }), [key, panelOpen])
  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>
}

export function useApiKey(): ApiKeyState {
  return useContext(ApiKeyContext)
}

// ------------------------------------------------------------------ words --

/**
 * Where the key for the next run comes from, in plain words. A UI key wins
 * because the server resolves the header first.
 */
export function keySourceLabel(server: LlmServerSource | null, uiKey: boolean): string {
  if (uiKey) return "Using the key entered here, this tab only, cleared on reload"
  if (server === "env") return "Using ANTHROPIC_API_KEY from the environment"
  if (server === "dotenv") return "Using the key from .env"
  return "No key set"
}

/** The same, in a word, for the header button. Empty while unknown. */
export function keyShortLabel(server: LlmServerSource | null, uiKey: boolean): string {
  if (uiKey) return "this tab"
  if (server === "env") return "env"
  if (server === "dotenv") return ".env"
  if (server === null) return ""
  return "not set"
}

const CHECKED: Record<LlmCheck["source"], string> = {
  header: "the key entered here",
  env: "ANTHROPIC_API_KEY from the environment",
  dotenv: "the key from .env",
  none: "no key",
}

export function checkMessage(check: LlmCheck): { ok: boolean; text: string } {
  if (check.source === "none") return { ok: false, text: "There is no key to check. Enter one above, or set ANTHROPIC_API_KEY in .env." }
  if (check.ok) return { ok: true, text: `The key works. Checked ${CHECKED[check.source]}.` }
  return { ok: false, text: `The key did not work. Checked ${CHECKED[check.source]}.` }
}

/**
 * Does this failure want the user to set a key? Only for the chat use case,
 * and only when the message is about a key or authentication.
 */
export function needsKey(transform: string, error: string | undefined): boolean {
  if (transform !== "chat" || !error) return false
  return /api[ _-]?key|anthropic_api_key|credential|authenticat|unauthori[sz]ed|\b401\b/i.test(error)
}
