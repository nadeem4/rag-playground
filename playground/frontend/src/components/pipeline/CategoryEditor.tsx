import { useEffect, useId, useState } from "react"

import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Picker } from "@/components/ui/Picker"
import { addFromTemplate, removeCategory, renameCategory } from "@/state/categories"
import { categoriesOf, type PipelineConfig } from "@/state/config"
import type { DocRef } from "@/state/sourceDocs"
import { INDEX_ORDER, orderTemplates, type IndexTemplate } from "@/state/templates"

/**
 * One category's settings in one place: its name, where it started, how many
 * documents use it, and Remove. Its Parse, Clean and Chunk are the cards below.
 * "Add a category" offers the templates.
 */
export function CategoryEditor({
  id,
  config,
  users,
  templates,
  onChange,
}: {
  id: string
  config: PipelineConfig
  users: DocRef[]
  templates: IndexTemplate[]
  onChange: (config: PipelineConfig) => void
}) {
  const field = useId()
  const [adding, setAdding] = useState(false)
  const def = categoriesOf(config)[id]
  const origin = templates.find((t) => t.id === def?.template)
  const removal = removeCategory(config, id, users)
  if (!def) return null
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <label htmlFor={field} className="text-xs text-fg-muted">
        Category name
      </label>
      <NameField key={id} id={field} name={def.name ?? (id === "default" ? "Default" : id)} onRename={(name) => onChange(renameCategory(config, id, name))} />
      {def.template ? <p className="text-fg-muted">{origin ? `Started from ${origin.name}` : `Started from ${def.template}`}</p> : null}
      <p>{`Used by ${users.length} ${users.length === 1 ? "document" : "documents"}`}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!removal.ok} onClick={() => removal.ok && onChange(removal.config)}>
          Remove
        </Button>
        {removal.ok ? null : <span className="text-fg-muted">{removal.problem}</span>}
      </div>
      <Button size="sm" variant="outline" className="self-start" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
        Add a category
      </Button>
      {adding ? (
        <ul className="flex flex-col gap-1">
          {orderTemplates(templates, INDEX_ORDER).map((t) => (
            <li key={t.id}>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto w-full flex-col items-start py-1 whitespace-normal"
                onClick={() => {
                  onChange(addFromTemplate(config, t).config)
                  setAdding(false)
                }}
              >
                <span className="font-semibold">{t.name}</span>
                <span className="font-normal text-fg-muted">{t.summary}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The name field keeps its own draft, so it can be cleared and retyped; the name is applied when the field loses focus, and an empty one keeps the previous name. */
function NameField({ id, name, onRename }: { id: string; name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name)
  return (
    <Input
      id={id}
      value={draft}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!draft.trim()) setDraft(name)
        else if (draft !== name) onRename(draft)
      }}
    />
  )
}

/** Asks for the name of the category a document moves to; the caller copies and moves. */
export function NewCategoryForm({ onSubmit, onCancel }: { onSubmit: (name: string) => void; onCancel: () => void }) {
  const field = useId()
  const [name, setName] = useState("")
  const clean = name.trim()
  return (
    <form
      className="flex flex-wrap items-center gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (clean) onSubmit(clean)
      }}
    >
      <label htmlFor={field} className="text-xs text-fg-muted">
        Name of the new category
      </label>
      <Input id={field} className="w-[240px]" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
      <Button type="submit" size="sm" disabled={!clean}>
        Move
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

/**
 * "Categories" under the tabs: the editor of one category. It starts on the
 * category of the document on show (`shown`); the menu picks any other. The
 * templates load when it first opens.
 */
export function CategoriesSection({
  shown,
  config,
  usersOf,
  onChange,
}: {
  shown: string
  config: PipelineConfig
  usersOf: (id: string) => DocRef[]
  onChange: (config: PipelineConfig) => void
}) {
  const label = useId()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [templates, setTemplates] = useState<IndexTemplate[] | null>(null)
  useEffect(() => {
    if (!open || templates) return
    let live = true
    api
      .templates()
      .then((t) => live && setTemplates(t.index))
      .catch(() => live && setTemplates([]))
    return () => {
      live = false
    }
  }, [open, templates])
  const cats = categoriesOf(config)
  const id = picked && picked in cats ? picked : shown
  return (
    <div className="border-b border-hairline">
      <Button variant="ghost" size="sm" className="m-2" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Categories
      </Button>
      {open ? (
        <>
          {Object.keys(cats).length > 1 ? (
            <div className="flex items-center gap-2 px-3">
              <span id={`${label}-label`} className="text-xs text-fg-muted">
                Category to edit
              </span>
              <Picker
                id={`${label}-menu`}
                labelledBy={`${label}-label`}
                options={Object.entries(cats).map(([k, c]) => ({ value: k, name: c.name ?? k }))}
                value={id}
                onChange={setPicked}
              />
            </div>
          ) : null}
          <CategoryEditor id={id} config={config} users={usersOf(id)} templates={templates ?? []} onChange={onChange} />
        </>
      ) : null}
    </div>
  )
}
