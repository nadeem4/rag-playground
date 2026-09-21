/**
 * Theme choice: "system" follows prefers-color-scheme, "light" / "dark" pin it.
 * The whole page switches at once (Page Theme Lock) by setting `data-theme`
 * on <html>; tokens.css does the rest. index.html applies a stored choice
 * before first paint. Storage is a per-viewer convenience and may throw.
 */

export type ThemeChoice = "system" | "light" | "dark"

const KEY = "rag-theme"

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === "system") delete root.dataset.theme
  else root.dataset.theme = choice
  try {
    if (choice === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}
