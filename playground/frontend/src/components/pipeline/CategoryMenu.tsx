import { useId } from "react"

import { Picker } from "@/components/ui/Picker"

/**
 * "Category: Reports with tables": the menu that moves the document on show to
 * another category. With one category there is nothing to choose.
 */
export function CategoryMenu({
  categories,
  value,
  onMove,
}: {
  categories: { id: string; name: string }[]
  value: string
  onMove: (id: string) => void
}) {
  const id = useId()
  if (categories.length < 2) return null
  return (
    <div className="flex items-center gap-2" title="Move to another category">
      <span id={`${id}-label`} className="text-xs text-fg-muted">
        Category
      </span>
      <Picker
        id={`${id}-menu`}
        labelledBy={`${id}-label`}
        options={categories.map((c) => ({ value: c.id, name: c.name }))}
        value={value}
        onChange={onMove}
      />
    </div>
  )
}
