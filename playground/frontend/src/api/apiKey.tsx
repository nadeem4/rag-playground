import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

import type { Graph, LlmCheck, LlmProvider, LlmServerSource, LlmSettings, Registry } from "./types"

/**
 * The API keys typed in the UI, one per provider (plan I-8, I-18).
 *
 * They live in React state inside this provider and NOWHERE else: never
 * localStorage, sessionStorage or IndexedDB, never the URL, never the stored
 * graph or a node config, never the console. A reload drops them. The client
 * sends each set key as its own header on runs, sweeps and that provider's
 * key check.
 */

export const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "custom", "openrouter"]

export const PROVIDER_INFO: Record<LlmProvider, { name: string; env: string }> = {
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openai: { name: "OpenAI", env: "OPENAI_API_KEY" },
  custom: { name: "Custom endpoint", env: "OPENAI_COMPATIBLE_API_KEY" },
  openrouter: { name: "OpenRouter", env: "OPENROUTER_API_KEY" },
}

export type Keys = Record<LlmProvider, string | null>

const NO_KEYS: Keys = { anthropic: null, openai: null, custom: null, openrouter: null }

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
 * wins because the server resolves the header first. Only the last 4
 * characters of a UI key are ever shown, and none for a key too short to hide
 * the rest.
 */
export function keySourceLabel(provider: LlmProvider, server: LlmServerSource | null, uiKey: string | null): string {
  if (uiKey !== null) return `Entered here${uiKey.length < 8 ? "" : `, ends in …${uiKey.slice(-4)}`}. This tab only, cleared on reload.`
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

/**
 * Is any key set anywhere, in this tab or on the server? Null while the server
 * has not answered and no key is set in this tab, since then nobody knows.
 */
export function hasAnyKey(server: LlmSettings | null, keys: Keys): boolean | null {
  if (PROVIDERS.some((p) => keys[p] !== null)) return true
  if (server === null) return null
  return PROVIDERS.some((p) => server[p] !== "none")
}

/**
 * The key a model choice needs: one provider's, none (a custom endpoint), or
 * some key when the model is not known (play safe rather than skip the stop).
 */
export type KeyNeed = { kind: "provider"; provider: LlmProvider } | { kind: "none" } | { kind: "any" }

/** The key slot for each model provider the server names in `x-providers`. */
const SLOT: Record<string, LlmProvider | null> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  openai_compatible: null,
}

/**
 * What key a model needs, from the `model` field's schema: its `x-providers`
 * map, and its `default` when the config names no model.
 */
export function keyNeedFor(schema: Record<string, unknown> | undefined, model: unknown): KeyNeed {
  const id = model ?? schema?.default
  if (id === "custom") return { kind: "none" }
  const provider = typeof id === "string" ? (schema?.["x-providers"] as Record<string, string> | undefined)?.[id] : undefined
  if (provider === undefined || !(provider in SLOT)) return { kind: "any" }
  const slot = SLOT[provider]
  return slot ? { kind: "provider", provider: slot } : { kind: "none" }
}

/** Is the needed key surely missing? False while the server has not answered. */
export function keyMissing(need: KeyNeed, server: LlmSettings | null, keys: Keys): boolean {
  if (need.kind === "none") return false
  if (need.kind === "any") return hasAnyKey(server, keys) === false
  return hasKeyFor(need.provider, server, keys) === false
}

/** "an OpenRouter", "an Anthropic": the article that goes with a provider's name. */
export function withArticle(provider: LlmProvider): string {
  const name = PROVIDER_INFO[provider].name
  return `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`
}

/** Is this provider's key set, in this tab or on the server? Null while unknown. */
export function hasKeyFor(provider: LlmProvider, server: LlmSettings | null, keys: Keys): boolean | null {
  if (keys[provider] !== null) return true
  if (server === null) return null
  return server[provider] !== "none"
}

/**
 * The strategies that call a model and so need a key: the ones the Ask panel
 * turns off when no key is set (the LLM reranker, the LLM rewrite and Chat),
 * and Build's Enrich step (llm_context).
 */
const KEY_TRANSFORMS = new Set(["llm_rerank", "llm_rewrite", "chat", "llm_context"])

export function needsApiKey(transform: string): boolean {
  return KEY_TRANSFORMS.has(transform)
}

/**
 * Build's model steps (Enrich) whose model needs a key that is surely not set,
 * by card id: the provider, or null when any key would do. The Ask panel's
 * model steps have their own stops.
 */
export function missingKeySteps(g: Graph, registry: Registry, server: LlmSettings | null, keys: Keys): Record<string, LlmProvider | null> {
  const out: Record<string, LlmProvider | null> = {}
  for (const n of g.nodes) {
    if (n.stage !== "enrich" || !needsApiKey(n.transform)) continue
    const of = registry.enrich
    const schema = of && Object.hasOwn(of, n.transform) ? of[n.transform].config_schema.properties?.model : undefined
    const need = keyNeedFor(schema, n.config.model)
    if (keyMissing(need, server, keys)) out[n.id] = need.kind === "provider" ? need.provider : null
  }
  return out
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
 * Does this failure want the user to set a key? Only for Chat and Enrich,
 * and only when the message is about a key or authentication.
 */
export function needsKey(transform: string, error: string | undefined): boolean {
  if ((transform !== "chat" && transform !== "llm_context") || !error) return false
  return /api[ _-]?key|credential|authenticat|unauthori[sz]ed|\b401\b/i.test(error)
}
