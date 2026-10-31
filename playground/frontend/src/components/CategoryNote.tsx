import { categoriesOf, type Into } from "@/state/config"

/**
 * The category a file is pinned to, beside its name. Shown only when the
 * pipeline has several categories and the file has a pin; otherwise nothing.
 */
export function CategoryNote({ category, into }: { category?: string; into?: Into }) {
  if (!into || !category) return null
  const all = categoriesOf(into.config)
  if (Object.keys(all).length < 2 || !all[category]) return null
  return (
    <span data-category-note="" className="text-xs text-fg-muted">
      in {all[category].name}
    </span>
  )
}
