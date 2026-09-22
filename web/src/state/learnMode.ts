import { useSyncExternalStore } from "react"

/**
 * Learn mode: when on, Build shows each stage's lesson and each setting's
 * hint. On by default for a first-time visitor. The choice is remembered in
 * per-viewer storage; when storage is blocked it lasts for this page only.
 */

const KEY = "rag-playground:learn-mode"

let current: boolean | null = null
const listeners = new Set<() => void>()

export function readLearnMode(): boolean {
  if (current === null) {
    try {
      current = window.localStorage.getItem(KEY) !== "off"
    } catch {
      current = true
    }
  }
  return current
}

export function setLearnMode(on: boolean): void {
  current = on
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off")
  } catch {
    // Private window or blocked storage: remembered in memory only.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLearnMode(): boolean {
  return useSyncExternalStore(subscribe, readLearnMode, readLearnMode)
}

/** For tests: forget the in-memory value so the next read goes to storage. */
export function resetLearnModeForTests(): void {
  current = null
}
