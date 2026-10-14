/**
 * Contrast choice: "system" follows prefers-contrast, "more" pins the
 * more-contrast tokens by setting `data-contrast="more"` on <html>; tokens.css
 * does the rest. index.html applies a stored choice before first paint.
 * Storage is a per-viewer convenience and may throw.
 */

export type ContrastChoice = "system" | "more"

const KEY = "rag-contrast"

export function readContrast(): ContrastChoice {
  try {
    return localStorage.getItem(KEY) === "more" ? "more" : "system"
  } catch {
    return "system"
  }
}

export function applyContrast(choice: ContrastChoice): void {
  const root = document.documentElement
  if (choice === "more") root.dataset.contrast = "more"
  else delete root.dataset.contrast
  try {
    if (choice === "more") localStorage.setItem(KEY, choice)
    else localStorage.removeItem(KEY)
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}
