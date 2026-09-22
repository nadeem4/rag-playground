import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

import type { LlmCheck, LlmProvider, LlmServerSource, LlmSettings } from "./types"

/**
 * The API keys typed in the UI, one per provider (plan I-8, I-18).
 *
 * They live in React state inside this provider and NOWHERE else: never
 * localStorage, sessionStorage or IndexedDB, never the URL, never the stored
 * graph or a node config, never the console. A reload drops them. The client
 * sends each set key as its own header on runs, sweeps and that provider's
 * key check.
 */

export const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "custom"]

export const PROVIDER_INFO: Record<LlmProvider, { name: string; env: string }> = {
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openai: { name: "OpenAI", env: "OPENAI_API_KEY" },
  custom: { name: "Custom endpoint", env: "OPENAI_COMPATIBLE_API_KEY" },
}

export type Keys = Record<LlmProvider, string | null>

const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null }

export interface ApiKeyState {
  /** The UI keys; null where none is set. */
  keys: Keys
  setKey: (provider: LlmProvider, key: string | null) => void
  /** The header panel, open or closed; other parts of the page can open it. */
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
}

const NONE: ApiKeyState = { keys: NO_KEYS, setKey: () => {}, panelOpen: false, setPanelOpen: () => {} }

const ApiKeyContext = createContext<ApiKeyState>(NONE)

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<Keys>(NO_KEYS)
  const [panelOpen, setPanelOpen] = useState(false)
  const setKey = useCallback((p: LlmProvider, key: string | null) => setKeys((k) => ({ ...k, [p]: key })), [])
  const value = useMemo(() => ({ keys, setKey, panelOpen, setPanelOpen }), [keys, setKey, panelOpen])
  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>
}

export function useApiKey(): ApiKeyState {
  return useContext(ApiKeyContext)
}

// ------------------------------------------------------------------ words --

/**
 * Where a provider's key for the next run comes from, in plain words. A UI key
 * wins because the server resolves the header first.
 */
export function keySourceLabel(provider: LlmProvider, server: LlmServerSource | null, uiKey: boolean): string {
  if (uiKey) return "Using the key entered here, this tab only, cleared on reload"
  if (server === "env") return `Using ${PROVIDER_INFO[provider].env} from the environment`
  if (server === "dotenv") return "Using the key from .env"
  return provider === "custom" ? "No key set. A local server may need none." : "No key set"
}

/** For the header button: how many providers have a key. Empty while unknown. */
export function keyShortLabel(server: LlmSettings | null, keys: Keys): string {
  const set = PROVIDERS.filter((p) => keys[p] !== null || (server !== null && server[p] !== "none")).length
  if (set > 0) return `${set} set`
  return server === null ? "" : "not set"
}

export function checkMessage(provider: LlmProvider, check: LlmCheck): { ok: boolean; text: string } {
  const checked = {
    header: "the key entered here",
    env: `${PROVIDER_INFO[provider].env} from the environment`,
    dotenv: "the key from .env",
    none: "no key",
  }[check.source]
  if (check.source === "none") return { ok: false, text: "There is no key to check. Enter one above." }
  if (check.ok) return { ok: true, text: `The key works. Checked ${checked}.` }
  return { ok: false, text: `The key did not work. Checked ${checked}.` }
}

/**
 * Does this failure want the user to set a key? Only for the chat use case,
 * and only when the message is about a key or authentication.
 */
export function needsKey(transform: string, error: string | undefined): boolean {
  if (transform !== "chat" || !error) return false
  return /api[ _-]?key|credential|authenticat|unauthori[sz]ed|\b401\b/i.test(error)
}
